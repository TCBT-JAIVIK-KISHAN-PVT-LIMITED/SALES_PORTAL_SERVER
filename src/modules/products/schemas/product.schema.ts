import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true, unique: true })
  zoho_item_id!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  description!: string;

  @Prop()
  sku!: string;

  @Prop()
  category_id!: string;

  @Prop()
  category_name!: string;

  @Prop()
  price!: number;

  @Prop()
  stock!: number;

  @Prop()
  unit!: string;

  @Prop()
  weight!: number;

  @Prop()
  weight_unit!: string;

  @Prop()
  dimensions!: string;

  @Prop()
  zoho_image_document_id!: string;

  @Prop({
    type: {
      image_key: String,
      image_url: String,
      image_hash: String,
      image_last_synced_at: Date,
      image_name: String,
      image_s3_key: String,
    },
    _id: false,
  })
  image!: {
    image_key: string;
    image_url: string;
    image_hash: string;
    image_last_synced_at: Date;
    image_name: string;
    image_s3_key: string;
  };

  @Prop({ default: true })
  is_active!: boolean;

  @Prop({ default: false })
  show_in_storefront!: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(Product);


ProductSchema.index({ category_id: 1 });
ProductSchema.index({ name: 'text', description: 'text' });
ProductSchema.index({ is_active: 1 });
ProductSchema.index({ price: 1 });
ProductSchema.index({ show_in_storefront: 1 });
