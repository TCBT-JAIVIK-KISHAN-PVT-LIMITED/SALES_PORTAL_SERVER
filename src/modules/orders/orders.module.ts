import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './schemas/order.schema';
import { PaymentsController } from '../../integrations/payments/payments.controller';
import { PaymentsModule } from '../../integrations/payments/payments.module';
import { OrdersController } from './orders.controller';
import { CartModule } from '../cart/cart.module';
import { ZohoModule } from '../../zoho/zoho.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { UsersModule } from '../users/users.module';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { ShippingModule } from '../../integrations/shipping/shipping.module';
import { SmsService } from './sms.service';
import { CouponModule } from '../coupon/coupon.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    UsersModule,
    ZohoModule,
    PaymentsModule,
    CartModule,
    ShippingModule,
    CouponModule
  ],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService, SmsService],
})
export class OrdersModule { }