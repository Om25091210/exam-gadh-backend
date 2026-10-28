import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class StartAttemptDto {
  @ApiProperty({ required: false, description: 'Practice attempts are never ranked' })
  @IsOptional()
  @IsBoolean()
  practice?: boolean;

  @ApiProperty({ required: false, enum: ['hi', 'en'] })
  @IsOptional()
  @IsIn(['hi', 'en'])
  language?: 'hi' | 'en';
}

export class AnswerStateDto {
  @ApiProperty({ description: 'TestVersionQuestion id (the qid in the attempt payload)' })
  @IsUUID()
  qid!: string;

  @ApiProperty({ nullable: true, description: 'Option index 0-3, null clears the response' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  selected?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  visited?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  marked?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(36_000)
  timeSpentSec?: number;

  @ApiProperty({ description: 'Per-question client sequence number; writes with a lower number than the stored one are ignored' })
  @IsInt()
  @Min(0)
  seq!: number;
}

export class SaveStateDto {
  @ApiProperty({ description: 'Monotonic client sequence for the navigation state' })
  @IsInt()
  @Min(0)
  seq!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  currentIndex?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  currentSection?: number;

  @ApiProperty({ required: false, enum: ['hi', 'en'] })
  @IsOptional()
  @IsIn(['hi', 'en'])
  language?: 'hi' | 'en';

  @ApiProperty({ type: [AnswerStateDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerStateDto)
  answers!: AnswerStateDto[];
}

export class SubmitDto {
  @ApiProperty({ description: 'Client-generated idempotency key; retrying with the same key returns the same result' })
  @IsString()
  @MaxLength(80)
  submitKey!: string;

  @ApiProperty({ required: false, type: [AnswerStateDto], description: 'Final unsaved answers, applied only while time remains' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerStateDto)
  answers?: AnswerStateDto[];
}
