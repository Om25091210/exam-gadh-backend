import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ example: 'pass_prelims' })
  @IsString()
  @MaxLength(40)
  planId!: string;

  @ApiProperty({ enum: [3, 6, 12] })
  @IsInt()
  @IsIn([3, 6, 12])
  months!: number;
}

export class VerifyPaymentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  razorpay_order_id!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  razorpay_payment_id!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  razorpay_signature!: string;
}

export class RedeemCouponDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  code!: string;
}
