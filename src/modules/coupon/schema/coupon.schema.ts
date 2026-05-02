import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CouponDocument = Coupon & Document;

@Schema({ timestamps: true })
export class Coupon {
  @Prop({ required: true, unique: true })
  name!: string;

  @Prop({ enum: ['flat', 'percent'], required: true })
  type!: 'flat' | 'percent';

  @Prop({ required: true })
  value!: number;

  @Prop()
  description?: string;

  @Prop({ default: true })
  show!: boolean;
}

export const CouponSchema = SchemaFactory.createForClass(Coupon);