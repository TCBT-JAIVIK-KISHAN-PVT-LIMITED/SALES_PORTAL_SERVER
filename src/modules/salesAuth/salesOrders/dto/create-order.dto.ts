import { IsArray, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class OrderItemDto {
  productId!: string;
  name!: string;
  price!: number;
  quantity!: number;
  weight!: number;
}

export class CreateOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsObject()
  address!: any;
}