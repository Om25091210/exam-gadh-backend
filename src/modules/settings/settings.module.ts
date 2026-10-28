import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from '../../common/clock';
import { SettingsService } from './settings.service';

@Global()
@Module({
  providers: [SettingsService, { provide: Clock, useClass: SystemClock }],
  exports: [SettingsService, Clock],
})
export class SettingsModule {}
