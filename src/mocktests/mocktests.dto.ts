import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class AnswerDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  questionId!: string;

  @ApiProperty({ nullable: true, description: 'Option index 0-3, or null to clear' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  selected?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  flagged?: boolean;

  @ApiProperty({ required: false, description: 'Seconds spent on this question so far' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(36_000)
  timeSpentSec?: number;
}

export class SaveAnswersDto {
  @ApiProperty({ type: [AnswerDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers!: AnswerDto[];
}
