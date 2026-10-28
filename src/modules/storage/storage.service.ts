import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError, badRequest } from '../../common/api-error';
import { ENV, Env } from '../../config/env';

export const S3_CLIENT = Symbol('S3_CLIENT');

export type UploadPurpose = 'question-image' | 'material-pdf' | 'ca-image' | 'doubt-image' | 'doubt-audio';

interface Rule {
  prefix: (owner?: string) => string;
  types: Record<string, string>; // content type -> file extension
  maxBytes: number;
}

const IMG = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/**
 * Keys are generated here, never taken from the client (no path tricks), and each upload is pinned to one
 * content type and a size limit by the signed form policy, so S3 itself refuses anything else.
 * Only keys under public/ are readable through the CDN; everything else is private and served by short-lived links.
 */
const RULES: Record<UploadPurpose, Rule> = {
  'question-image': { prefix: () => 'public/question-images', types: IMG, maxBytes: 1024 * 1024 },
  'ca-image': { prefix: () => 'public/ca-images', types: IMG, maxBytes: 2 * 1024 * 1024 },
  'material-pdf': { prefix: () => 'materials', types: { 'application/pdf': 'pdf' }, maxBytes: 25 * 1024 * 1024 },
  'doubt-image': { prefix: (o) => `doubts/${o}`, types: IMG, maxBytes: 3 * 1024 * 1024 },
  'doubt-audio': { prefix: (o) => `doubts/${o}`, types: { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }, maxBytes: 5 * 1024 * 1024 },
};

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private bucket() {
    if (!this.env.mediaBucket) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not set up yet');
    return this.env.mediaBucket;
  }

  async presignUpload(purpose: UploadPurpose, contentType: string, owner?: string) {
    const rule = RULES[purpose];
    const ext = rule.types[contentType];
    if (!ext) throw badRequest('UNSUPPORTED_TYPE', `Allowed types for ${purpose}: ${Object.keys(rule.types).join(', ')}`);
    const key = `${rule.prefix(owner)}/${randomUUID()}.${ext}`;
    const post = await createPresignedPost(this.s3, {
      Bucket: this.bucket(),
      Key: key,
      Conditions: [['content-length-range', 1, rule.maxBytes], ['eq', '$Content-Type', contentType]],
      Fields: { 'Content-Type': contentType },
      Expires: 300,
    });
    return { key, url: post.url, fields: post.fields, maxBytes: rule.maxBytes, expiresInSec: 300 };
  }

  /** A link that works for 10 minutes; used for private files (paid PDFs, doubt attachments). */
  async presignDownload(key: string, filename?: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket(), Key: key, ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"` : undefined }), { expiresIn: 600 });
  }

  /** Public images (question/CA pictures) are served by CloudFront. */
  publicUrl(key: string | null | undefined) {
    if (!key) return null;
    return this.env.mediaCdnDomain ? `https://${this.env.mediaCdnDomain}/${key}` : null;
  }
}

@Global()
@Module({
  providers: [
    { provide: S3_CLIENT, inject: [ENV], useFactory: (env: Env) => new S3Client({ region: env.awsRegion }) }, // credentials: the server's IAM role
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
