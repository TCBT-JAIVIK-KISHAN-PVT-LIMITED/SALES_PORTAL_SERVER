import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, unique: true })
  orderId!: string;

  @Prop({ type: Array, required: true })
  items!: {
    productId: string;
    name: string;
    price: number;
    quantity: number;
    weight: number;
    image?: string;

    // 🔥 IMPORTANT (for Zoho Inventory mapping)
    sku?: string;
    zohoItemId?: string;
  }[];

  @Prop({ required: true })
  totalAmount!: number;

  @Prop({ required: true })
  shippingCharge!: number;

  @Prop({ required: true })
  finalAmount!: number;

  // 📦 ORDER STATUS
  @Prop({
    enum: ['created', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'],
    default: 'created',
  })
  orderStatus!: string;

  // 💳 PAYMENT STATUS
  @Prop({
    enum: ['pending', 'paid', 'failed'],
    default: 'pending',
  })
  paymentStatus!: string;

  @Prop({ type: Object, required: true })
  address!: {
    name: string;
    phone: string;
    pincode: string;
    city: string;
    state: string;
    addressLine: string;
  };

  // 💳 Payment Fields
  @Prop()
  paymentSessionId?: string;

  @Prop()
  paymentId?: string;

  @Prop()
  couponName?: string;

  @Prop({ default: 0 })
  discount?: number;

  // 🔥 Zoho Inventory Fields
  @Prop()
  zohoSalesOrderId?: string;

  @Prop({ default: false })
  isSyncedToZoho?: boolean;

  @Prop()
  zohoSyncError?: string;

  // 📦 Shipment (future)
  @Prop()
  shipmentId?: string;

  @Prop()
  trackingId?: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);