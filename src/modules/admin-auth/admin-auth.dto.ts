import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty() @IsEmail() @MaxLength(200) email!: string;
  @ApiProperty() @IsString() @Length(1, 128) password!: string;
}

export class TotpCodeDto {
  @ApiProperty({ description: '6-digit authenticator code' }) @IsString() @Length(6, 6) code!: string;
}

export class MfaDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @Length(6, 6) code?: string;
  @ApiProperty({ required: false, description: 'One-time recovery code, e.g. abcde-fghjk' }) @IsOptional() @IsString() @MaxLength(20) recoveryCode?: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @Length(1, 128) currentPassword!: string;
  @ApiProperty() @IsString() @Length(1, 128) newPassword!: string;
}
