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

  async getItems(page = 1, perPage = 200): Promise<any> {
    return this.http.request(
      'GET',
      `https://www.zohoapis.in/inventory/v1/items?organization_id=${this.getOrgId()}&page=${page}&per_page=${perPage}`,
      'inventory',
    );
  }

  async getItem(itemId: string): Promise<any> {
    const response = await this.http.request(
      'GET',
      `https://www.zohoapis.in/inventory/v1/items/${itemId}?organization_id=${this.getOrgId()}`,
      'inventory',
    );

    return response?.item || null;
  }

  async downloadItemImage(itemId: string): Promise<Buffer> {
    return this.http.request(
      'GET',
      `https://www.zohoapis.in/inventory/v1/items/${itemId}/image?organization_id=${this.getOrgId()}`,
      'inventory',
      undefined,
      { responseType: 'arraybuffer' },
    );
  }

  async getItemImageUploadPayload(itemId: string, existingHash?: string) {
    const imageUrl = `https://www.zohoapis.in/inventory/v1/items/${itemId}/image?organization_id=${this.getOrgId()}`;
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

  async createSalesOrder(order: any, customerId: string) {
    const payload = {
      customer_id: customerId,

      reference_number: order.orderId,

      line_items: order.items.map((item: any) => ({
        item_id: item.zohoItemId,
        name: item.name,
        rate: item.price,
        quantity: item.quantity,
      })),

      shipping_charge: order.shippingCharge,

      billing_address: {
        address: this.limitAddress(
          order.address.billingAddress || order.address.addressLine,
        ),
        city: order.address.city,
        state: order.address.state,
        zip: order.address.pincode,
        phone: order.address.phone,
      },

      shipping_address: {
        address: this.limitAddress(
          order.address.billingAddress || order.address.addressLine,
        ),
        city: order.address.city,
        state: order.address.state,
        zip: order.address.pincode,
        phone: order.address.phone,
      },
    };

    const response = await this.http.request(
      'POST',
      `https://www.zohoapis.in/inventory/v1/salesorders?organization_id=${this.getOrgId()}`,
      'inventory',
      payload,
    );

    return response.salesorder?.salesorder_id;
  }

  async findOrCreateSalesCustomer(customer: any) {
    const searchText = encodeURIComponent(
      customer.customerPhone || customer.mobile || customer.customerName,
    );

    if (searchText) {
      const search = await this.http.request(
        'GET',
        `https://www.zohoapis.in/inventory/v1/contacts?organization_id=${this.getOrgId()}&search_text=${searchText}`,
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
      `https://www.zohoapis.in/inventory/v1/contacts?organization_id=${this.getOrgId()}`,
      'inventory',
      payload,
    );

    return response.contact?.contact_id;
  }
}
