
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CouponService } from './coupon.service';
import { Coupon, CouponSchema } from './schema/coupon.schema';
import { CouponController } from './coupon.controller';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Coupon.name, schema: CouponSchema },
        ]),
    ],
    providers: [CouponService],
    controllers: [CouponController],
    exports: [
        MongooseModule,
    ],
})
export class CouponModule { }