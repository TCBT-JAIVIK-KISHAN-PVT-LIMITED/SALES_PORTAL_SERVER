import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Order } from './schemas/order.schema';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ZohoPaymentGatewayService } from '../../integrations/payments/zoho-payment-gateway.service';
import { User } from '../users/schemas/user.schema';
import { ZohoInventoryService } from '../../zoho/inventory/inventory.service';
import { CartService } from '../cart/cart.service';
import { Product } from '../products/schemas/product.schema';
import { ShippingService } from '../../integrations/shipping/shipping.service';
import { UsersService } from '../users/users.service';
import { SmsService } from './sms.service';
import { Coupon } from '../coupon/schema/coupon.schema';

@Injectable()
export class OrdersService {
  constructor(
    private zohoInventoryService: ZohoInventoryService,
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Product.name) private productModel: Model<Product>,
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly usersService: UsersService,
    private cartService: CartService,
    private paymentService: ZohoPaymentGatewayService,
    private shippingService: ShippingService,
    private readonly smsService: SmsService,
    @InjectModel(Coupon.name)
    private couponModel: Model<Coupon>,
  ) { }

  async createOrder(userId: string, dto: any) {
    const { items, address, totalWeight, discount = 0, couponName = null } = dto;

    if (!totalWeight || totalWeight <= 0) {
      throw new BadRequestException('Invalid total weight from cart');
    }

    let totalAmount = 0;

    const processedItems = items.map((item: any) => {
      totalAmount += item.price * item.quantity;

      return {
        productId: item.productId,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        weight: item.weight,
        image: item.image,
      };
    });

    const discountedAmount = Math.max(totalAmount - discount, 0);

    const type_of_package = totalWeight < 20000 ? 'SPS' : 'B2B';

    console.log('Total Weight:', totalWeight);
    console.log('Type of Package:', type_of_package);
    console.log('Delivery Pincode:', address.pincode);
    const shipping = await this.shippingService.calculateRate(
      totalWeight,
      Number(address.pincode),
      type_of_package,
    );

    const shippingCharge = shipping.shippingCharge;
    console.log('Calculated Shipping Charge:', shippingCharge);
    const finalAmount = discountedAmount + shippingCharge;

    const order = await this.orderModel.create({
      userId,
      orderId: `ORD-${uuidv4()}`,
      items: processedItems,
      totalAmount,
      shippingCharge,
      finalAmount,
      address,
      orderStatus: 'created',
      paymentStatus: 'pending',
    });

    const payment = await this.paymentService.createPaymentSession(order);


    order.paymentSessionId = payment?.payments_session_id;
    await order.save();

    return {
      shippingCharge,
      finalAmount,
      orderId: order.orderId,
      paymentSessionId: order.paymentSessionId,
    };
  }

  async createOrderFromCart(userId: string, addressId: any, couponId?: string,) {
    const cart = await this.cartService.getCartSummaryByUser(userId);

    if (!cart || cart.items.length === 0) {
      throw new Error('Cart is empty');
    }

    const items = await Promise.all(
      cart.items.map(async (item: any) => {
        const product = await this.productModel.findById(item.product_id);

        if (!product) {
          throw new Error(`Product not found: ${item.product_id}`);
        }

        return {
          productId: product._id,
          name: product.name,
          price: product.price,
          quantity: item.quantity,
          weight: product.weight || 1,
          image: product.image?.image_url,
          zohoItemId: product.zoho_item_id,
        };
      }),
    );
    const address = await this.usersService.findAddressById(
      userId,
      addressId,
    );

    if (!address) {
      throw new Error('Address not found');
    }

    let discount = 0;
    let couponName: string | null = null;

    if (couponId) {
      const coupon = await this.couponModel.findById(couponId);

      if (!coupon) {
        throw new NotFoundException('Coupon not found');
      }

      couponName = coupon.name || null;

      if (coupon.type === 'flat') {
        discount = coupon.value;
      } else if (coupon.type === 'percent') {
        discount = (cart.total_amount * coupon.value) / 100;
      }
    }
    const order = await this.createOrder(userId, {
      items,
      address,
      totalWeight: cart.totalWeight,
      discount,
      couponName,
    });

    return order;
  }

  async getOrders(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const filter = {
      userId,
      paymentStatus: { $in: ['paid', 'failed'] },
    };

    const [orders, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),

      this.orderModel.countDocuments(filter),
    ]);

    return {
      data: orders,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getOrderById(userId: string, orderId: string) {
    const order = await this.orderModel.findOne({
      userId,
      orderId,
    });

    if (!order) {
      throw new Error('Order not found');
    }

    return order;
  }

  async cancelOrder(userId: string, orderId: string) {
    const order = await this.orderModel.findOne({
      userId,
      orderId,
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.orderStatus === 'cancelled') {
      throw new BadRequestException('Order already cancelled');
    }

    if (order.orderStatus === 'confirmed') {
      throw new BadRequestException('Cannot cancel confirmed order');
    }

    order.orderStatus = 'cancelled';
    await order.save();

    return { message: 'Order cancelled successfully' };
  }

  async handlePaymentSuccess(orderId: string, paymentId: string, amount: number) {
    const order = await this.orderModel.findOne({ orderId });

    if (!order) throw new Error('Order not found');

    if (order.paymentStatus === 'paid') return;

    if (Math.abs(order.finalAmount - Number(amount)) > 0.01) {
      throw new Error('Amount mismatch');
    }

    order.paymentStatus = 'paid';
    order.orderStatus = 'confirmed';
    order.paymentId = paymentId;

    await order.save();

    await this.cartService.getOrCreateForUser(order.userId).then(c => {
      c.items = [];
      return c.save();
    });

    const user = await this.userModel.findById(order.userId);

    if (!user?.zoho_contact_id) {
      order.zohoSyncError = 'Missing zoho_contact_id';
      await order.save();
      return;
    }

    try {
      const zohoOrderId = await this.zohoInventoryService.createSalesOrder(
        order,
        user.zoho_contact_id,
      );

      order.zohoSalesOrderId = zohoOrderId;
      order.isSyncedToZoho = true;
      order.orderStatus = 'processing';

      await order.save();
    } catch (error: any) {
      console.error('Zoho Sync Failed:', error);

      order.zohoSyncError = error.message;
      await order.save();
    }
  }

  async verifyAndConfirmOrder(orderId: string): Promise<any> {
    const order = await this.orderModel.findOne({ orderId });

    if (!order) throw new NotFoundException('Order not found');

    console.log('🔍 Order found:', {
      orderId: order?.orderId,
      paymentStatus: order?.paymentStatus,
      paymentSessionId: order?.paymentSessionId,
    });

    const receiver_phone = (order as any)?.address?.receiver_phone;


    if (order.paymentStatus === 'paid') {
      if (receiver_phone) {
        this.smsService
          .sendOrderSuccessSMS(
            receiver_phone,
            order.finalAmount,
            order.orderId,
          )
          .catch(err => console.error('SMS async error:', err));
      }

      return { status: 'paid', orderId: order.orderId };
    }

    if (!order.paymentSessionId) {
      throw new BadRequestException('No payment session linked to this order');
    }

    const result = await this.paymentService.verifyPaymentSessionStatus(
      order.paymentSessionId,
    );

    console.log('🔍 Zoho session result:', result);

    const { status, paymentId, amount } = result;


    if (status === 'succeeded' && paymentId && amount) {
      await this.handlePaymentSuccess(
        orderId,
        paymentId,
        parseFloat(amount),
      );


      if (receiver_phone) {
        this.smsService
          .sendOrderSuccessSMS(
            receiver_phone,
            parseFloat(amount),
            order.orderId,
          )
          .catch(err => console.error('SMS async error:', err));
      }

      return { status: 'paid', orderId: order.orderId };
    }


    await this.handlePaymentFailure(orderId);

    return { status: 'failed', orderId: order.orderId };
  }

  async handlePaymentFailure(orderId: string) {
    const order = await this.orderModel.findOne({ orderId });

    if (!order) return;

    if (order.paymentStatus === 'paid') return;

    order.paymentStatus = 'failed';
    await order.save();
  }
} 