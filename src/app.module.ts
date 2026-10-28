import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AccessModule } from './access/access.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { ENV, Env, loadEnv } from './config/env';
import { ContentController } from './content/content.controller';
import { HealthController } from './health/health.controller';
import { AttemptsModule } from './modules/attempts/attempts.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { AuditModule } from './modules/audit/audit.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersController } from './users/users.controller';
import { Global, Module as NestModule } from '@nestjs/common';

@Global()
@NestModule({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
class ConfigModule {}

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.logLevel,
          autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
          // Secrets never reach the logs.
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-razorpay-signature"]', 'req.body.idToken', 'req.body.refreshToken'],
            censor: '[redacted]',
          },
        },
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
      // Only the test suite turns this off (see test/setup-env.ts); a dedicated spec proves it works.
      skipIf: () => process.env.THROTTLE_DISABLED === '1',
    }),
    PrismaModule,
    AccessModule,
    AuthModule,
    BillingModule,
    SettingsModule,
    AuditModule,
    AdminAuthModule,
    AttemptsModule,
  ],
  controllers: [HealthController, ContentController, UsersController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
