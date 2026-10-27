import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ENV, Env } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleOAuthVerifier, GoogleVerifier } from './google-verifier';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionService } from './session.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ secret: env.jwtSecret, signOptions: { algorithm: 'HS256' } }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionService, JwtAuthGuard, { provide: GoogleVerifier, useClass: GoogleOAuthVerifier }],
  exports: [SessionService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
