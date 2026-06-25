import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Order } from './schemas/order.schema';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ZohoPaymentGatewayService } from '../../integrations/payments/zoho-payment-gateway.service';
import { User } from '../users/schemas/user.schema';
import { ZohoInventoryService } from '../../zoho/inventory/inventory.service';
import { CartService } from '../cart/cart.service';
import { AppApiService } from '../../common/app-api.service';
import { ShippingService } from '../../integrations/shipping/shipping.service';
import { UsersService } from '../users/users.service';
import { SmsService } from './sms.service';
import { Coupon } from '../coupon/schema/coupon.schema';
import { CommunicationService } from './communication.service';
import { SendQuotationDto } from './dto/send-quotation.dto';

@Injectable()
export class OrdersService {
  constructor(
    private zohoInventoryService: ZohoInventoryService,
    @InjectModel(Order.name) private orderModel: Model<Order>,
    private appApi: AppApiService,
    @InjectModel(User.name) private userModel: Model<User>,
    private readonly usersService: UsersService,
    private cartService: CartService,
    private paymentService: ZohoPaymentGatewayService,
    private shippingService: ShippingService,
    private readonly smsService: SmsService,
    private readonly communicationService: CommunicationService,
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
        zohoItemId: item.zohoItemId || item.zoho_item_id,
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

  async sendQuotation(payload: SendQuotationDto) {
    if (!payload.customerPhone?.trim()) {
      throw new BadRequestException('customerPhone is required');
    }

    if (payload.channel === 'sms') {
      await this.communicationService.sendQuotationSms(payload);
      return { success: true, channel: 'sms' };
    }

    if (payload.channel === 'whatsapp') {
      await this.communicationService.sendQuotationWhatsapp(payload);
      return { success: true, channel: 'whatsapp' };
    }

    throw new BadRequestException('Unsupported channel');
  }

  async createOrderFromCart(userId: string, addressId: any, couponId?: string,) {
    const cart = await this.cartService.getCartSummaryByUser(userId);

    if (!cart || cart.items.length === 0) {
      throw new Error('Cart is empty');
    }

    const items = await Promise.all(
      cart.items.map(async (item: any) => {
        // Fetch product from app server API using zoho_item_id or product_id
        const lookupId = item.zoho_item_id || item.product_id;
        const product = lookupId
          ? await this.appApi.getProductById(String(lookupId))
          : null;

        if (!product) {
          throw new Error(`Product not found: ${item.product_id}`);
        }

        return {
          productId: product._id || product.zoho_item_id,
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
    console.log('\n----- [RegularOrder] handlePaymentSuccess START -----');
    console.log('[RegularOrder] orderId:', orderId, '| paymentId:', paymentId, '| amount:', amount);

    const order = await this.orderModel.findOne({ orderId });
    console.log('[RegularOrder] DB lookup result:', order ? `found (userId: ${order.userId}, finalAmount: ${order.finalAmount})` : '❌ NOT FOUND in orders collection');

    if (!order) throw new Error('Order not found');

    if (order.paymentStatus === 'paid') {
      console.log('[RegularOrder] Already paid — skipping');
      return;
    }

    const diff = Math.abs(order.finalAmount - Number(amount));
    console.log('[RegularOrder] Amount check — order.finalAmount:', order.finalAmount, '| incoming amount:', amount, '| diff:', diff);
    if (diff > 0.01) {
      console.error('[RegularOrder] ❌ Amount mismatch!');
      throw new Error('Amount mismatch');
    }

    order.paymentStatus = 'paid';
    order.orderStatus = 'confirmed';
    order.paymentId = paymentId;
    await order.save();
    console.log('[RegularOrder] ✅ Order marked as paid & saved');

    try {
      await this.cartService.getOrCreateForUser(order.userId).then(c => {
        c.items = [];
        return c.save();
      });
      console.log('[RegularOrder] ✅ Cart cleared for userId:', order.userId);
    } catch (cartErr: any) {
      console.warn('[RegularOrder] ⚠️ Cart clear failed (non-critical):', cartErr?.message);
    }

    console.log('[RegularOrder] Looking up user by userId:', order.userId);
    const user = await this.userModel.findById(order.userId);
    console.log('[RegularOrder] User lookup:', user ? `found (name: ${user.name}, zoho_contact_id: ${user.zoho_contact_id || '❌ MISSING'})` : '❌ NOT FOUND');

    if (!user) {
      order.zohoSyncError = 'User not found';
      await order.save();
      console.error('[RegularOrder] ❌ Aborting — user not found for userId:', order.userId);
      return;
    }

    // ── Step 1: Auto-create Zoho contact if missing ──
    let zohoContactId = user.zoho_contact_id;
    console.log('[RegularOrder] Step 1 — zohoContactId from user:', zohoContactId || '❌ MISSING — will create');

    if (!zohoContactId) {
      try {
        console.log('[RegularOrder] Calling createOrGetContact with:', { name: user?.name, mobile_number: user?.mobile_number, email: user?.email });
        zohoContactId = await this.zohoInventoryService.createOrGetContact({
          name: user?.name,
          mobile_number: user?.mobile_number,
          email: user?.email,
        });
        console.log('[RegularOrder] ✅ Got zohoContactId:', zohoContactId);

        await this.userModel.findByIdAndUpdate(order.userId, { zoho_contact_id: zohoContactId });
        console.log('[RegularOrder] ✅ Saved zoho_contact_id to user');
      } catch (err: any) {
        console.error('[RegularOrder] ❌ createOrGetContact FAILED:', err.message);
        order.zohoSyncError = `Contact creation failed: ${err.message}`;
        await order.save();
        return;
      }
    }

    // ── Step 2: Full Zoho sync ──
    console.log('[RegularOrder] Step 2 — Starting Zoho sync. zohoContactId:', zohoContactId);
    console.log('[RegularOrder] Items to sync:', order.items?.map((i: any) => ({ name: i.name, zohoItemId: i.zohoItemId || '❌ MISSING', qty: i.quantity, price: i.price })));

    try {
      const result = await this.zohoInventoryService.createSalesOrderWithInvoice(
        order,
        zohoContactId,
      );

      order.zohoSalesOrderId = result.salesOrderId;
      order.zohoInvoiceId = result.invoiceId;
      order.zohoInvoiceNumber = result.invoiceNumber;
      order.zohoPaymentId = result.paymentId;
      order.isSyncedToZoho = true;
      order.orderStatus = 'processing';

      await order.save();
      console.log(
        `[RegularOrder] ✅ Zoho sync complete — SO: ${result.salesOrderId}, Invoice: ${result.invoiceNumber}, Payment: ${result.paymentId}`,
      );
    } catch (error: any) {
      console.error('[RegularOrder] ❌ Zoho sync FAILED:', error.message);
      console.error('[RegularOrder] Stack:', error.stack);
      order.zohoSyncError = error.message;
      await order.save();
    }
    console.log('----- [RegularOrder] handlePaymentSuccess END -----\n');
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