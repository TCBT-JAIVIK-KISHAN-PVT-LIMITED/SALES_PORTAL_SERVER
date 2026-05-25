import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

class QuotationItemDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @Type(() => Number)
  @IsNumber()
  quantity!: number;

  @Type(() => Number)
  @IsNumber()
  rate!: number;
}

export class SendQuotationDto {
  @IsString()
  @IsNotEmpty()
  customerPhone!: string;

  @IsString()
  @IsNotEmpty()
  customerName!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuotationItemDto)
  items!: QuotationItemDto[];

  @Type(() => Number)
  @IsNumber()
  subtotal!: number;

  @Type(() => Number)
  @IsNumber()
  gst!: number;

  @Type(() => Number)
  @IsNumber()
  grandTotal!: number;

  @IsString()
  @IsNotEmpty()
  quoteNumber!: string;

  @IsString()
  @IsNotEmpty()
  date!: string;

  @IsEnum(['sms', 'whatsapp'])
  channel!: 'sms' | 'whatsapp';

  @IsOptional()
  @IsString()
  @IsUrl()
  paymentLink?: string;

  @IsOptional()
  @IsString()
  message?: string;
}
