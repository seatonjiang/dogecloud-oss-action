import { getInput, info, setFailed } from "@actions/core";
import { join, isAbsolute, relative, sep, dirname } from "path";
import { promises } from "fs";
import { lookup } from "mime-types";
import { createHmac } from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

/**
 * 读取并校验输入参数
 *
 * @returns {{accessKey:string, secretKey:string, bucket:string, localPath:string, remotePath:string}}
 */
function getInputs() {
  const accessKey = getInput("access_key", { required: true });
  const secretKey = getInput("secret_key", { required: true });
  const bucket = getInput("bucket", { required: true });
  const localPath = getInput("local_path", { required: true });
  const remotePath = getInput("remote_path") || "";

  return { accessKey, secretKey, bucket, localPath, remotePath };
}

/**
 * 调用多吉云接口获取登录凭证
 *
 * @param {string} accessKey 多吉云 AccessKey
 * @param {string} secretKey 多吉云 SecretKey
 * @param {string} bucket 存储桶名称
 * @returns {Promise<{credentials: any, s3Bucket: string, s3Endpoint: string}>}
 */
async function dogecloudApi(accessKey, secretKey, bucket) {
  const apiPath = "/auth/tmp_token.json";
  const payload = {
    channel: "OSS_UPLOAD",
    scopes: [bucket + ":*"],
  };

  const bodyJSON = JSON.stringify(payload);
  const signStr = apiPath + "\n" + bodyJSON;
  const sign = createHmac("sha1", secretKey)
    .update(Buffer.from(signStr, "utf8"))
    .digest("hex");

  const headers = {
    "Content-Type": "application/json",
    Authorization: "TOKEN " + accessKey + ":" + sign,
  };

  const resp = await fetch("https://api.dogecloud.com" + apiPath, {
    method: "POST",
    headers,
    body: bodyJSON,
  });

  if (!resp.ok) {
    throw new Error(`${resp.status} ${resp.statusText}`);
  }

  const body = await resp.json();
  if (!body || body.code !== 200) {
    throw new Error(`${body && body.msg}`);
  }

  const data = body.data || {};
  return {
    credentials: data.Credentials,
    s3Bucket: data.Buckets && data.Buckets[0] && data.Buckets[0].s3Bucket,
    s3Endpoint: data.Buckets && data.Buckets[0] && data.Buckets[0].s3Endpoint,
  };
}

/**
 * 获取多吉云登录凭证
 *
 * @param {string} accessKey 多吉云 AccessKey
 * @param {string} secretKey 多吉云 SecretKey
 * @param {string} bucket 存储桶名称
 * @returns {Promise<{credentials:{accessKeyId:string, secretAccessKey:string, sessionToken?:string}, s3Bucket?:string, s3Endpoint?:string}>}
 */
async function getTemporaryCredentials(accessKey, secretKey, bucket) {
  const apiRes = await dogecloudApi(accessKey, secretKey, bucket);
  const c =
    apiRes &&
    (apiRes.credentials || apiRes.Credentials || apiRes.credential || apiRes);
  if (!c) throw new Error("未获取到登录凭证！");

  /** 规范化字段 */
  const accessKeyId =
    c.accessKeyId || c.AccessKeyId || c.AccessKey || c.ak || c.AK;
  const secretAccessKey =
    c.secretAccessKey || c.SecretAccessKey || c.SecretKey || c.sk || c.SK;
  const sessionToken = c.sessionToken || c.SessionToken || c.token || c.Token;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("未获取到登录凭证！");
  }

  return {
    credentials: { accessKeyId, secretAccessKey, sessionToken },
    s3Bucket: apiRes && apiRes.s3Bucket,
    s3Endpoint: apiRes && apiRes.s3Endpoint,
  };
}

/**
 * 创建 S3 客户端
 *
 * @param {{endpoint:string, credentials:{accessKeyId:string, secretAccessKey:string, sessionToken?:string}, forcePathStyle:boolean}} cfg
 * @returns {S3Client}
 */
function createS3Client(cfg) {
  const requestHandler = new NodeHttpHandler({
    requestTimeout: 10 * 60 * 1000,
    connectionTimeout: 30 * 1000,
  });

  return new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: cfg.credentials,
    forcePathStyle: true,
    maxAttempts: 5,
    requestHandler,
  });
}

/**
 * 递归列出目录中的所有文件
 *
 * @param {string} baseDir 目录路径
 * @returns {Promise<string[]>} 绝对路径文件列表
 */
async function listLocalFiles(baseDir) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} d */
  async function walk(d) {
    const entries = await promises.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile()) {
        files.push(p);
      }
    }
  }
  await walk(baseDir);
  return files;
}

/**
 * 上传单个文件到 S3
 *
 * @param {S3Client} s3 S3 客户端
 * @param {string} bucket 目标 Bucket
 * @param {string} fileAbsPath 本地文件绝对路径
 * @param {string} key 对象 Key（含可选前缀）
 * @param {{acl?:string, cacheControl?:string}} opts 额外参数
 * @returns {Promise<void>}
 */
async function uploadFile(s3, bucket, fileAbsPath, key) {
  const body = await promises.readFile(fileAbsPath);
  const contentType = lookup(fileAbsPath) || "application/octet-stream";
  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  };

  let attempt = 0;
  const maxAttempts = 3;
  // 简单退避：2s，4s，8s 上限
  while (true) {
    try {
      await s3.send(new PutObjectCommand(params));
      return;
    } catch (err) {
      attempt += 1;
      const isTimeout =
        err && (err.name === "TimeoutError" || err.code === "ETIMEDOUT");
      const isRetryable = isTimeout || (err && err.$retryable);
      if (attempt < maxAttempts && isRetryable) {
        const backoff = Math.min(2000 * attempt, 8000);
        info(
          `上传重试(${attempt}/${maxAttempts})：${key}，原因：${
            err && (err.name || err.message || err)
          }`
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}

/**
 * 主流程：读取传入参数 → 获取登录凭证 → 上传目录文件
 *
 * @returns {Promise<void>}
 */
async function run() {
  try {
    const { accessKey, secretKey, bucket, localPath, remotePath } = getInputs();

    // 解析上传路径
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const uploadPath = isAbsolute(localPath)
      ? localPath
      : join(workspace, localPath);
    const stat = await promises.stat(uploadPath).catch(() => null);
    if (!stat) {
      throw new Error(`本地路径不存在或不可访问：${uploadPath}`);
    }

    const { credentials, s3Bucket, s3Endpoint } = await getTemporaryCredentials(
      accessKey,
      secretKey,
      bucket
    );
    if (!s3Endpoint || !s3Bucket) {
      throw new Error("API 未返回 s3Endpoint 或 s3Bucket，无法继续上传");
    }

    const s3 = createS3Client({ endpoint: s3Endpoint, credentials });

    /**
     * 构造待上传文件列表与相对路径基准
     */
    let files = [];
    let baseDir = uploadPath;
    if (stat.isDirectory()) {
      files = await listLocalFiles(uploadPath);
      if (files.length === 0) {
        info("目录为空，无文件可上传");
        return;
      }
    } else if (stat.isFile()) {
      files = [uploadPath];
      baseDir = dirname(uploadPath);
    } else {
      throw new Error(`本地路径既不是文件也不是目录：${uploadPath}`);
    }

    info(`凭证获取成功，开始上传任务，共 ${files.length} 个文件`);

    for (const file of files) {
      const rel = relative(baseDir, file);
      // 使用 POSIX 分隔符，避免 Windows 反斜杠
      const relPosix = rel.split(sep).join("/");
      const key = remotePath
        ? `${remotePath.replace(/\/$/, "")}/${relPosix}`
        : relPosix;
      await uploadFile(s3, s3Bucket, file, key);
      info(`已上传：${key}`);
    }

    info("全部文件上传成功！");
  } catch (err) {
    setFailed(err.message || String(err));
  }
}

run();
