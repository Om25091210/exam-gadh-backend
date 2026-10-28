import { Injectable } from '@nestjs/common';

/** Injectable time source so deadline logic is testable without sleeping. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now() {
    return new Date();
  }
}
