import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Order } from './schemas/order.schema';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ZohoPaymentGatewayService } from '../../../integrations/payments/zoho-payment-gateway.service';
import { ZohoInventoryService } from '../../../zoho/inventory/inventory.service';
import { Product } from '../../products/schemas/product.schema';
import { ShippingService } from '../../../integrations/shipping/shipping.service';
import { SmsService } from './sms.service';
import { Coupon } from '../../coupon/schema/coupon.schema';
import { CommunicationService } from './communication.service';
import { SendQuotationDto } from './dto/send-quotation.dto';
import { SalesDocument } from '../models/sales-document.schema';

@Injectable()
export class OrdersService {
  constructor(
    private zohoInventoryService: ZohoInventoryService,
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Product.name) private productModel: Model<Product>,
    private paymentService: ZohoPaymentGatewayService,
    private shippingService: ShippingService,
    private readonly smsService: SmsService,
    private readonly communicationService: CommunicationService,
    @InjectModel(Coupon.name)
    private couponModel: Model<Coupon>,
  ) { }

  async createOrder(salesId: string, dto: any) {
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
    const deliveryPincode = address.pincode || address.pin;
    console.log('Delivery Pincode:', deliveryPincode);
    const shipping = await this.shippingService.calculateRate(
      totalWeight,
      Number(deliveryPincode),
      type_of_package,
    );

    const shippingCharge = shipping.shippingCharge;
    console.log('Calculated Shipping Charge:', shippingCharge);
    const finalAmount = discountedAmount + shippingCharge;

    const order = await this.orderModel.create({
      salesId,
      salesName: dto.salesName,
      quotationNumber: dto.quotationNumber || dto.documentNumber || orderIdFromDto(dto),
      invoiceNumber: dto.invoiceNumber,
      customerName: dto.customerName || address?.name || address?.customerName,
      customerPhone:
        dto.customerPhone ||
        address?.phone ||
        address?.receiver_phone ||
        address?.mobile,
      orderId: `ORD-${uuidv4()}`,
      items: processedItems,
      totalAmount,
      shippingCharge,
      finalAmount,
      address: this.normalizeAddress(address),
      discount,
      couponName,
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

  async createOrUpdatePaidOrderFromQuotation(params: {
    quotation: SalesDocument;
    paymentId?: string;
    amount?: number;
  }) {
    const { quotation, paymentId, amount } = params;
    const data: any = quotation.data || {};
    const quotationNumber = quotation.documentNumber;
    const invoiceNumber =
      data.relatedInvoiceNumber ||
      quotationNumber.replace('QT-', 'INV-');
    const orderId = `SO-${quotationNumber}`;
    const normalizedItems = this.normalizeQuotationItems(
      quotation.items?.length ? quotation.items : data.items || [],
    );
    const address = this.normalizeAddress({
      name: quotation.customerName || data.customerName,
      phone: quotation.customerPhone || data.customerPhone || data.mobile,
      pincode: data.pin || data.pincode,
      city: data.district || data.city,
      state: data.state,
      addressLine:
        data.billingAddress ||
        data.addressLine ||
        data.village ||
        '',
      billingAddress: data.billingAddress || data.addressLine || data.village,
      district: data.district,
    });
    const finalAmount = Number(amount || quotation.grandTotal || 0);
    const totalAmount = Number(quotation.subtotal || finalAmount);

    const order = await this.orderModel.findOneAndUpdate(
      {
        salesId: quotation.salesperson_id,
        quotationNumber,
      },
      {
        $set: {
          salesId: quotation.salesperson_id,
          salesName: quotation.salesName,
          quotationNumber,
          invoiceNumber,
          customerName: quotation.customerName || data.customerName || '',
          customerPhone:
            quotation.customerPhone || data.customerPhone || data.mobile || '',
          orderId,
          items: normalizedItems,
          totalAmount,
          shippingCharge: 0,
          finalAmount,
          address,
          orderStatus: 'confirmed',
          paymentStatus: 'paid',
          paymentId: paymentId || quotation.transactionId,
          paymentDate:
            quotation.paymentDate || new Date().toISOString().split('T')[0],
          discount: Number(data.discount || 0),
          couponName: data.couponName || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    if (order.isSyncedToZoho) {
      this.logSavedOrderDetails(order);
      return order;
    }

    await this.syncPaidSalesOrderToZoho(order);
    return order;
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

  async createSalesOrder(salesId: string, dto: any) {
    const { address, couponId } = dto;
    const rawItems = Array.isArray(dto.items) ? dto.items : [];

    if (!rawItems.length) {
      throw new BadRequestException('Order items are required');
    }

    const items = await Promise.all(
      rawItems.map(async (item: any) => {
        const productId = item.productId || item.product_id || item.id;
        const product = productId
          ? await this.productModel.findById(productId)
          : item.zohoItemId || item.zoho_item_id
            ? await this.productModel.findOne({
              zoho_item_id: String(item.zohoItemId || item.zoho_item_id),
            })
            : null;

        if (!product) {
          throw new Error(`Product not found: ${productId || item.name}`);
        }

        const quantity = Number(item.quantity || 0);
        if (quantity <= 0) {
          throw new BadRequestException(`Invalid quantity for ${product.name}`);
        }

        const weight =
          Number(item.weight) ||
          (product.weight_unit === 'kg'
            ? Number(product.weight || 0) * 1000
            : Number(product.weight || 0));

        return {
          productId: product._id,
          name: product.name,
          price: Number(item.price || product.price || 0),
          quantity,
          weight,
          image: product.image?.image_url,
          zohoItemId: product.zoho_item_id,
        };
      }),
    );

    if (!address) {
      throw new Error('Address not found');
    }

    const totalWeight =
      Number(dto.totalWeight) ||
      items.reduce(
        (sum, item) => sum + Number(item.weight || 0) * Number(item.quantity || 0),
        0,
      );

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
        const subtotal = items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0,
        );
        discount = (subtotal * coupon.value) / 100;
      }
    }
    const order = await this.createOrder(salesId, {
      items,
      address,
      totalWeight,
      discount,
      couponName,
    });

    return order;
  }

  async getOrders(salesId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const filter = {
      salesId,
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

  async getOrderById(salesId: string, orderId: string) {
    const order = await this.orderModel.findOne({
      salesId,
      orderId,
    });

    if (!order) {
      throw new Error('Order not found');
    }

    return order;
  }

  async cancelOrder(salesId: string, orderId: string) {
    const order = await this.orderModel.findOne({
      salesId,
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

    await this.syncPaidSalesOrderToZoho(order);
  }

  async verifyAndConfirmOrder(orderId: string): Promise<any> {
    const order = await this.orderModel.findOne({ orderId });

    if (!order) throw new NotFoundException('Order not found');

    console.log('🔍 Order found:', {
      orderId: order?.orderId,
      paymentStatus: order?.paymentStatus,
      paymentSessionId: order?.paymentSessionId,
    });

    const receiver_phone =
      (order as any)?.address?.receiver_phone || (order as any)?.address?.phone;


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

  private toSalesCustomer(order: Order) {
    const address: any = order.address || {};
    return {
      customerName: address.name || address.receiver_name || 'Sales Portal Customer',
      customerPhone:
        address.phone ||
        address.receiver_phone ||
        address.mobile ||
        address.customerPhone ||
        '',
      mobile:
        address.phone ||
        address.receiver_phone ||
        address.mobile ||
        address.customerPhone ||
        '',
      billingAddress: this.limitZohoAddress(
        address.billingAddress || address.addressLine || address.village || '',
      ),
      village: address.village || '',
      district: address.city || address.district || '',
      state: address.state || '',
      pin: address.pincode || address.pin || '',
    };
  }

  private normalizeAddress(address: any) {
    return {
      ...address,
      name: address.name || address.receiver_name || address.customerName || '',
      phone:
        address.phone ||
        address.receiver_phone ||
        address.mobile ||
        address.customerPhone ||
        '',
      pincode: address.pincode || address.pin || '',
      city: address.city || address.district || '',
      state: address.state || '',
      addressLine:
        this.limitZohoAddress(address.billingAddress) ||
        address.addressLine ||
        address.village ||
        '',
      billingAddress: this.limitZohoAddress(
        address.billingAddress ||
        address.addressLine ||
        address.village ||
        '',
      ),
    };
  }

  private limitZohoAddress(value: any) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 99 ? normalized.slice(0, 99) : normalized;
  }

  private normalizeQuotationItems(items: any[]) {
    return items.map((item: any) => {
      const quantity = Number(item.quantity || item.qty || 0);
      const price = Number(item.price || item.rate || item.amount || 0);

      return {
        productId: item.productId || item.product_id || item.id || '',
        name: item.name || item.productName || '',
        price,
        quantity,
        weight: Number(item.weight || 0),
        image: item.image || item.image_url,
        sku: item.sku,
        zohoItemId:
          item.zohoItemId ||
          item.zoho_item_id ||
          item.raw?.zoho_item_id ||
          item.item_id,
      };
    });
  }

  private async syncPaidSalesOrderToZoho(order: any) {
    const customerId = await this.zohoInventoryService.findOrCreateSalesCustomer(
      this.toSalesCustomer(order),
    );

    if (!customerId) {
      order.zohoSyncError = 'Unable to create/find Zoho customer';
      await order.save();
      this.logSavedOrderDetails(order);
      return;
    }

    try {
      const zohoOrderId = await this.zohoInventoryService.createSalesOrder(
        order,
        customerId,
      );

      order.zohoSalesOrderId = zohoOrderId;
      order.isSyncedToZoho = true;
      order.orderStatus = 'processing';

      await order.save();
      this.logSavedOrderDetails(order);
    } catch (error: any) {
      console.error('Zoho Sync Failed:', error);

      order.zohoSyncError = error.message;
      await order.save();
      this.logSavedOrderDetails(order);
    }
  }

  private logSavedOrderDetails(order: any) {
    const savedOrder =
      typeof order.toObject === 'function' ? order.toObject() : order;

    console.log(
      'SALES_ORDER_SAVED_IN_MONGO:',
      JSON.stringify(savedOrder, null, 2),
    );
  }
} 

function orderIdFromDto(dto: any) {
  return dto.orderId || dto.quotationNumber || dto.documentNumber || '';
}
