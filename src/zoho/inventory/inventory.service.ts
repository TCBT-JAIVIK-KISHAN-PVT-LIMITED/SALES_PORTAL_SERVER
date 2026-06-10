import { Injectable } from '@nestjs/common';
import { ZohoHttpService } from '../core/zoho-http.service';
import { ConfigService } from '@nestjs/config';
import { ZohoAuthService } from '../core/zoho-auth.service';

@Injectable()
export class ZohoInventoryService {
  constructor(
    private http: ZohoHttpService,
    private config: ConfigService,
    private zohoAuthService: ZohoAuthService,
  ) { }

  private getOrgId() {
    return this.config.get<string>('ZOHO_ORG_ID') || '';
  }

  private limitAddress(value: any) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 99 ? normalized.slice(0, 99) : normalized;
  }

  private inventoryUrl(path: string) {
    const separator = path.includes('?') ? '&' : '?';
    return `https://www.zohoapis.in/inventory/v1${path}${separator}organization_id=${this.getOrgId()}`;
  }

  // Simple in-memory cache: name.toLowerCase() → zoho salesperson_id
  private salespersonCache: Record<string, string> = {};

  async findSalespersonId(name: string): Promise<string | null> {
    // 1. Direct env override — set ZOHO_SALESPERSON_ID in .env to bypass API lookup
    const envId = this.config.get<string>('ZOHO_SALESPERSON_ID');
    if (envId) {
      console.log('[ZohoInventory] Using ZOHO_SALESPERSON_ID from env:', envId);
      return envId;
    }

    if (!name) return null;
    const key = name.toLowerCase().trim();
    if (this.salespersonCache[key]) return this.salespersonCache[key];

    // 2. Try /users endpoint (Zoho Inventory users serve as salespersons)
    try {
      const usersRes = await this.http.request(
        'GET',
        this.inventoryUrl('/users'),
        'inventory',
      );
      const users: any[] = usersRes?.users || [];
      console.log('[ZohoInventory] Users from Zoho (/users):', users.map((u: any) => ({
        user_id: u.user_id,
        name: u.name,
        role: u.role,
        email: u.email,
      })));
      for (const u of users) {
        if (u.user_id && u.name) {
          this.salespersonCache[(u.name || '').toLowerCase().trim()] = u.user_id;
        }
      }
      if (this.salespersonCache[key]) {
        console.log('[ZohoInventory] ✅ Found salesperson via /users:', this.salespersonCache[key]);
        return this.salespersonCache[key];
      }
    } catch (err: any) {
      console.warn('[ZohoInventory] Could not fetch /users:', err?.message);
    }

    // 3. Fall back to /salespersons
    try {
      const spRes = await this.http.request(
        'GET',
        this.inventoryUrl('/salespersons'),
        'inventory',
      );
      const list: any[] = spRes?.salespersons || [];
      console.log('[ZohoInventory] Salespersons from /salespersons:', list.map((s: any) => ({
        id: s.salesperson_id,
        name: s.name,
      })));
      for (const sp of list) {
        if (sp.salesperson_id && sp.name) {
          this.salespersonCache[(sp.name || '').toLowerCase().trim()] = sp.salesperson_id;
        }
      }
      return this.salespersonCache[key] || null;
    } catch (err: any) {
      console.warn('[ZohoInventory] Could not fetch /salespersons:', err?.message);
      return null;
    }
  }

  async getItems(page = 1, perPage = 200): Promise<any> {
    return this.http.request(
      'GET',
      this.inventoryUrl(`/items?page=${page}&per_page=${perPage}`),
      'inventory',
    );
  }

  async getItem(itemId: string): Promise<any> {
    const response = await this.http.request(
      'GET',
      this.inventoryUrl(`/items/${itemId}`),
      'inventory',
    );

    return response?.item || null;
  }

  async downloadItemImage(itemId: string): Promise<Buffer> {
    return this.http.request(
      'GET',
      this.inventoryUrl(`/items/${itemId}/image`),
      'inventory',
      undefined,
      { responseType: 'arraybuffer' },
    );
  }

  async getItemImageUploadPayload(itemId: string, existingHash?: string) {
    const imageUrl = this.inventoryUrl(`/items/${itemId}/image`);
    const token = await this.zohoAuthService.getValidAccessToken('inventory');
    try {
      await this.http.request('GET', imageUrl, 'inventory', undefined, {
        responseType: 'stream',
      });
    } catch (err: any) {
      if (err?.response?.status === 400 || err?.response?.status === 404) {
        throw new Error(`NO_IMAGE: Item ${itemId} has no image in Zoho`);
      }
      throw err;
    }

    return { imageUrl, itemId, zohoToken: token, existingHash };
  }

  async createSalesOrder(order: any, customerId: string, salespersonId?: string) {
    const missingZohoItems = (order.items || []).filter(
      (item: any) => !item.zohoItemId,
    );

    if (missingZohoItems.length > 0) {
      throw new Error(
        `Missing Zoho item id for: ${missingZohoItems
          .map((item: any) => item.name || item.productId || 'Unknown item')
          .join(', ')}`,
      );
    }

    const addrLine = this.limitAddress(
      order.address?.billingAddress || order.address?.addressLine || '',
    );

    console.log('[ZohoInventory] Address debug:', {
      billingAddress: order.address?.billingAddress,
      addressLine: order.address?.addressLine,
      city: order.address?.city,
      state: order.address?.state,
      zip: order.address?.pincode,
      computed_addrLine: addrLine,
      addrLine_length: addrLine.length,
    });

    const payload: any = {
      customer_id: customerId,
      reference_number: order.orderId,
      line_items: order.items.map((item: any) => ({
        item_id: item.zohoItemId,
        name: item.name,
        rate: item.price,
        quantity: item.quantity,
      })),
      shipping_charge: order.shippingCharge,
      // Note: billing_address/shipping_address omitted — Zoho uses the contact's stored address.
      // Sending it was causing "billing_address > 100 chars" errors from Zoho.
    };

    if (salespersonId) {
      payload.salesperson_id = salespersonId;
      console.log('[ZohoInventory] Using salesperson_id:', salespersonId);
    } else {
      console.warn('[ZohoInventory] ⚠️ No salesperson_id — Zoho may reject if salespersons are required');
    }

    console.log('[ZohoInventory] Creating sales order payload:', JSON.stringify({
      customer_id: payload.customer_id,
      reference_number: payload.reference_number,
      line_items: payload.line_items.map((li: any) => ({
        item_id: li.item_id || '❌ MISSING',
        name: li.name,
        rate: li.rate,
        quantity: li.quantity,
      })),
      shipping_charge: payload.shipping_charge,
    }, null, 2));

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/salesorders'),
      'inventory',
      payload,
    );

    console.log('[ZohoInventory] ✅ Sales order created:', response.salesorder?.salesorder_id);

    return response.salesorder?.salesorder_id;
  }

  async getSalesOrder(salesOrderId: string): Promise<any> {
    const response = await this.http.request(
      'GET',
      this.inventoryUrl(`/salesorders/${salesOrderId}`),
      'inventory',
    );

    return response?.salesorder || null;
  }

  async findInvoiceByNumber(invoiceNumber: string): Promise<any> {
    if (!invoiceNumber) return null;

    const response = await this.http.request(
      'GET',
      this.inventoryUrl(`/invoices?invoice_number=${encodeURIComponent(invoiceNumber)}`),
      'inventory',
    );

    return response?.invoices?.find(
      (invoice: any) => invoice.invoice_number === invoiceNumber,
    ) || null;
  }

  async createInvoiceForPaidOrder(
    order: any,
    customerId: string,
    salesOrderId?: string,
  ): Promise<any> {
    const invoiceNumber = order.invoiceNumber || order.orderId;
    const existingInvoice = await this.findInvoiceByNumber(invoiceNumber);
    if (existingInvoice?.invoice_id) return existingInvoice;

    const salesOrder = salesOrderId ? await this.getSalesOrder(salesOrderId) : null;
    const salesOrderLineItems = Array.isArray(salesOrder?.line_items)
      ? salesOrder.line_items
      : [];

    const payload = {
      customer_id: customerId,
      invoice_number: invoiceNumber,
      reference_number: order.orderId,
      date: order.paymentDate || new Date().toISOString().split('T')[0],
      line_items: order.items.map((item: any) => {
        const salesOrderLineItem = salesOrderLineItems.find(
          (lineItem: any) => String(lineItem.item_id) === String(item.zohoItemId),
        );

        return {
          item_id: item.zohoItemId,
          salesorder_item_id: salesOrderLineItem?.line_item_id,
          name: item.name,
          rate: item.price,
          quantity: item.quantity,
        };
      }),
      shipping_charge: order.shippingCharge || 0,
      billing_address: {
        address: this.limitAddress(
          order.address?.billingAddress || order.address?.addressLine,
        ),
        city: order.address?.city,
        state: order.address?.state,
        zip: order.address?.pincode,
        phone: order.address?.phone,
      },
      shipping_address: {
        address: this.limitAddress(
          order.address?.billingAddress || order.address?.addressLine,
        ),
        city: order.address?.city,
        state: order.address?.state,
        zip: order.address?.pincode,
        phone: order.address?.phone,
      },
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/invoices?ignore_auto_number_generation=true'),
      'inventory',
      payload,
    );

    return response?.invoice || null;
  }

  async recordCustomerPaymentForInvoice(params: {
    customerId: string;
    invoiceId: string;
    amount: number;
    paymentId?: string;
    paymentDate?: string;
  }): Promise<any> {
    const referenceNumber = params.paymentId || params.invoiceId;

    const existingPayments = await this.http.request(
      'GET',
      this.inventoryUrl(`/customerpayments?reference_number=${encodeURIComponent(referenceNumber)}`),
      'inventory',
    );

    const existingPayment = existingPayments?.customerpayments?.find(
      (payment: any) => payment.reference_number === referenceNumber,
    );
    if (existingPayment?.payment_id) return existingPayment;

    const payload = {
      customer_id: params.customerId,
      payment_mode: 'others',
      amount: Number(params.amount || 0),
      date: params.paymentDate || new Date().toISOString().split('T')[0],
      reference_number: referenceNumber,
      description: 'Paid online through Zoho Payments',
      invoices: [
        {
          invoice_id: params.invoiceId,
          amount_applied: Number(params.amount || 0),
        },
      ],
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/customerpayments'),
      'inventory',
      payload,
    );

    return response?.payment || null;
  }

  async findOrCreateSalesCustomer(customer: any) {
    const searchText = encodeURIComponent(
      customer.customerPhone || customer.mobile || customer.customerName,
    );

    if (searchText) {
      const search = await this.http.request(
        'GET',
        this.inventoryUrl(`/contacts?search_text=${searchText}`),
        'inventory',
      );

      const existing = search?.contacts?.find((contact: any) => {
        const phone = String(customer.customerPhone || customer.mobile || '');
        return (
          contact.contact_id &&
          (contact.phone === phone ||
            contact.mobile === phone ||
            contact.contact_name === customer.customerName)
        );
      });

      if (existing?.contact_id) return existing.contact_id;
    }

    const payload = {
      contact_name: customer.customerName || 'Sales Portal Customer',
      contact_type: 'customer',
      phone: customer.customerPhone || customer.mobile || '',
      mobile: customer.customerPhone || customer.mobile || '',
      billing_address: {
        address: this.limitAddress(
          customer.billingAddress ||
            [customer.village, customer.district].filter(Boolean).join(', '),
        ),
        city: customer.district || '',
        state: customer.state || '',
        zip: customer.pin || '',
        phone: customer.customerPhone || customer.mobile || '',
      },
      shipping_address: {
        address: this.limitAddress(
          customer.billingAddress ||
            [customer.village, customer.district].filter(Boolean).join(', '),
        ),
        city: customer.district || '',
        state: customer.state || '',
        zip: customer.pin || '',
        phone: customer.customerPhone || customer.mobile || '',
      },
    };

    const response = await this.http.request(
      'POST',
      this.inventoryUrl('/contacts'),
      'inventory',
      payload,
    );

    return response.contact?.contact_id;
  }

  async markInvoiceAsSent(invoiceId: string): Promise<any> {
    const response = await this.http.request(
      'POST',
      this.inventoryUrl(`/invoices/${invoiceId}/status/sent`),
      'inventory',
    );

    return response?.invoice || null;
  }

  /**
   * Find an existing Zoho Inventory contact by phone number, or create a new one.
   * Used by the regular (non-salesperson) orders pipeline.
   * Returns the contact_id string.
   */
  async createOrGetContact(user: {
    name?: string;
    mobile_number: string;
    email?: string;
  }): Promise<string> {
    const orgId = this.getOrgId();

    // 1. Search for existing contact by phone
    try {
      const searchRes = await this.http.request(
        'GET',
        this.inventoryUrl(`/contacts?phone=${encodeURIComponent(user.mobile_number)}`),
        'inventory',
      );

      const contacts = searchRes?.contacts ?? [];
      const match = contacts.find(
        (c: any) =>
          c.phone === user.mobile_number || c.mobile === user.mobile_number,
      );

      if (match?.contact_id) {
        console.log(`[Zoho] Found existing contact: ${match.contact_id} for ${user.mobile_number}`);
        return match.contact_id;
      }
    } catch (err: any) {
      console.warn(`[Zoho] Contact search failed: ${err.message}, will create new`);
    }

    // 2. Create new contact
    const contactName = user.name || 'App Customer';
    const payload: any = {
      contact_name: contactName,
      contact_type: 'customer',
      phone: user.mobile_number,
      mobile: user.mobile_number,
    };

    if (user.email) {
      payload.email = user.email;
    }

    const createRes = await this.http.request(
      'POST',
      this.inventoryUrl('/contacts'),
      'inventory',
      payload,
    );

    const contactId = createRes?.contact?.contact_id;
    if (!contactId) {
      throw new Error(
        'Failed to create Zoho Inventory contact — no contact_id returned',
      );
    }

    console.log(`[Zoho] Created new contact: ${contactId} for ${user.mobile_number}`);
    return contactId;
  }
}
