import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
})
export class SalesSubAdmin extends Document {
  @Prop({ required: true, unique: true, trim: true })
  subadmin_id!: string;

  @Prop({ required: true })
  password_hash!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ trim: true, lowercase: true })
  email?: string;

  @Prop({ trim: true })
  mobile_number?: string;

  @Prop({ required: true, default: 'subadmin' })
  role!: string;

  @Prop({ default: true })
  is_active!: boolean;

  @Prop({ required: true })
  created_by_admin_id!: string;

  @Prop()
  last_login_at?: Date;
}

export const SalesSubAdminSchema = SchemaFactory.createForClass(SalesSubAdmin);
export type SalesSubAdminDocument = SalesSubAdmin & Document;
