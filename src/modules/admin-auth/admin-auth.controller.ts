import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { ADMIN_COOKIE, AdminRequest } from './admin-auth.types';
import { AdminLoginDto, ChangePasswordDto, MfaDto, TotpCodeDto } from './admin-auth.dto';
import { AdminAuthService, IssuedSession } from './admin-auth.service';
import { AnyAdmin, PreMfa } from './admin.decorators';
import { AdminGuard } from './admin.guard';

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private setCookie(res: Response, s: IssuedSession) {
    res.cookie(ADMIN_COOKIE, s.token, { httpOnly: true, secure: this.env.adminCookieSecure, sameSite: 'strict', path: '/', expires: s.expiresAt });
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: AdminLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { issued, body } = await this.auth.login(dto.email, dto.password, req.ip, req.headers['user-agent']);
    this.setCookie(res, issued);
    return body;
  }

  @Post('totp/setup')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @PreMfa()
  totpSetup(@Req() req: AdminRequest) {
    return this.auth.totpSetup(req.admin);
  }

  @Post('totp/enable')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @PreMfa()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async totpEnable(@Req() req: AdminRequest, @Body() dto: TotpCodeDto, @Res({ passthrough: true }) res: Response) {
    const { issued, recoveryCodes } = await this.auth.totpEnable(req.admin, dto.code, req.ip);
    this.setCookie(res, issued);
    return { csrfToken: issued.csrfToken, recoveryCodes };
  }

  @Post('mfa')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @PreMfa()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async mfa(@Req() req: AdminRequest, @Body() dto: MfaDto, @Res({ passthrough: true }) res: Response) {
    const issued = await this.auth.mfa(req.admin, dto, req.ip);
    this.setCookie(res, issued);
    return { csrfToken: issued.csrfToken };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  @AnyAdmin()
  me(@Req() req: AdminRequest) {
    return this.auth.me(req.admin);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @AnyAdmin()
  async logout(@Req() req: AdminRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.admin, req.ip);
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(AdminGuard)
  @AnyAdmin()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  changePassword(@Req() req: AdminRequest, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.admin, dto.currentPassword, dto.newPassword, req.ip);
  }
}
