import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesDocumentType = 'quotation' | 'invoice';
export type SalesDocumentDocument = SalesDocument & Document;

@Schema({ timestamps: true })
export class SalesDocument {
  @Prop({ required: true, index: true })
  salesperson_id!: string;

  @Prop({ required: true })
  salesName!: string;

  @Prop({ required: true, enum: ['quotation', 'invoice'], index: true })
  type!: SalesDocumentType;

  @Prop({ required: true, index: true })
  documentNumber!: string;

  @Prop()
  relatedQuotationNumber?: string;

  @Prop({ required: true })
  customerName!: string;

  @Prop()
  customerPhone?: string;

  @Prop({ default: 0 })
  subtotal!: number;

  @Prop({ default: 0 })
  gst!: number;

  @Prop({ default: 0 })
  grandTotal!: number;

  @Prop({ type: Array, default: [] })
  items!: any[];

  @Prop({ type: Object, required: true })
  data!: Record<string, any>;

  @Prop()
  zohoSalesOrderId?: string;

  @Prop({ default: false })
  isSyncedToZoho?: boolean;

  @Prop()
  zohoSyncError?: string;
}

export const SalesDocumentSchema = SchemaFactory.createForClass(SalesDocument);

SalesDocumentSchema.index(
  { salesperson_id: 1, type: 1, documentNumber: 1 },
  { unique: true },
);
SalesDocumentSchema.index({ salesperson_id: 1, createdAt: -1 });
