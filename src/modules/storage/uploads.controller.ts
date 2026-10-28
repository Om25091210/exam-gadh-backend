import { Body, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { zod } from '../../common/zod';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { StorageService } from './storage.service';

const body = z.object({ purpose: z.enum(['question-image', 'ca-image', 'material-pdf']), contentType: z.string().max(100) });

@AdminController('uploads')
export class AdminUploadsController {
  constructor(private readonly storage: StorageService) {}

  /** Returns a signed form: the browser uploads straight to S3, the API never handles the bytes. */
  @Post('presign')
  @HttpCode(200)
  @RequirePermission('content:write')
  presign(@Body(zod(body)) b: z.infer<typeof body>) {
    return this.storage.presignUpload(b.purpose, b.contentType);
  }
}
