import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { SendQuotationDto } from './dto/send-quotation.dto';

@Injectable()
export class CommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  private normalizePhone(phone: string) {
    const clean = phone.replace(/\D/g, '');
    return clean.startsWith('91') ? clean : `91${clean}`;
  }

  private formatQuotationText(payload: SendQuotationDto) {
    const lines = [
      '🌿 TCBT Jaivik Kisan',
      '📋 Quotation: ' + payload.quoteNumber,
      '📅 Date: ' + payload.date,
      '👤 Customer: ' + payload.customerName,
      '━━━━━━━━━━━━━━━━',
      '📦 Products:',
    ];

    payload.items.forEach((item, index) => {
      const total = item.rate * item.quantity;
      lines.push(`${index + 1}. ${item.name} × ${item.quantity} = ₹${total.toFixed(2)}`);
    });

    lines.push('━━━━━━━━━━━━━━━━');
    lines.push(`Subtotal: ₹${payload.subtotal.toFixed(2)}`);
    if (payload.gst > 0) {
      lines.push(`GST: ₹${payload.gst.toFixed(2)}`);
    }
    lines.push(`*Grand Total: ₹${payload.grandTotal.toFixed(2)}*`);

    if (payload.paymentLink) {
      lines.push('💳 Payment Link: ' + payload.paymentLink);
    }

    lines.push('✅ Valid for 7 days');
    lines.push('📞 +91 90390 07835');
    lines.push('🌱 TCBT Jaivik Kisan Pvt. Ltd.');

    if (payload.message) {
      lines.push('');
      lines.push(payload.message);
    }

    return lines.join('\n');
  }

  async sendQuotationSms(payload: SendQuotationDto): Promise<void> {
    const message = this.formatQuotationText(payload);
    await this.sendSms(payload.customerPhone, message);
  }

  async sendQuotationWhatsapp(payload: SendQuotationDto): Promise<void> {
    const message = this.formatQuotationText(payload);
    await this.sendWhatsApp(payload.customerPhone, message);
  }

  private async sendSms(phone: string, text: string) {
    const authKey = process.env.MSG91_AUTH_KEY;
    const sender = process.env.MSG91_SMS_SENDER_ID || 'TCBTIN';
    const normalizedPhone = this.normalizePhone(phone);

    if (!authKey) {
      throw new Error('MSG91_AUTH_KEY is not configured');
    }

    const payload = {
      sender,
      route: '4',
      country: '91',
      sms: [
        {
          message: text,
          to: [normalizedPhone],
        },
      ],
    };

    this.logger.log(`Sending quotation SMS to ${normalizedPhone}`);

    await axios.post('https://api.msg91.com/api/v5/onewaysms', payload, {
      headers: {
        authkey: authKey,
        'Content-Type': 'application/json',
      },
    });
  }

  private async sendWhatsApp(phone: string, text: string) {
    const apiUrl = process.env.WHATSAPP_API_URL;
    const apiKey = process.env.WHATSAPP_API_KEY;
    const normalizedPhone = this.normalizePhone(phone);

    if (!apiUrl || !apiKey) {
      throw new Error('WHATSAPP_API_URL and WHATSAPP_API_KEY are required for WhatsApp delivery');
    }

    this.logger.log(`Sending quotation WhatsApp to ${normalizedPhone}`);

    await axios.post(
      apiUrl,
      {
        to: normalizedPhone,
        type: 'text',
        text: {
          body: text,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
  }
}
