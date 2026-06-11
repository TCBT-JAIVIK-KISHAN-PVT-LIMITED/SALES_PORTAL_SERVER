import { Injectable } from '@nestjs/common';
import { ZohoHttpService } from '../core/zoho-http.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ZohoBooksService {
  constructor(
    private readonly http: ZohoHttpService,
    private readonly config: ConfigService,
  ) {}

  private getOrgId() {
    return this.config.get<string>('ZOHO_ORG_ID') || '';
  }

  private booksUrl(path: string) {
    const separator = path.includes('?') ? '&' : '?';
    return `https://www.zohoapis.in/books/v3${path}${separator}organization_id=${this.getOrgId()}`;
  }

  async createSalesperson(name: string, email?: string) {
    const payload: any = {
      salesperson_name: name,
    };
    if (email) {
      payload.salesperson_email = email;
    }

    console.log('[ZohoBooks] Creating salesperson payload:', payload);

    const res = await this.http.request(
      'POST',
      this.booksUrl('/salespersons'),
      'books',
      payload,
    );

    console.log('[ZohoBooks] Salesperson creation response:', res);
    return res?.salesperson;
  }

  async findSalespersonId(name: string, email?: string): Promise<string | null> {
    try {
      const res = await this.http.request(
        'GET',
        this.booksUrl('/salespersons'),
        'books',
      );
      const list = res?.data || res?.salespersons || [];

      // Try email first
      if (email) {
        const match = list.find(
          (sp: any) =>
            sp.salesperson_email?.toLowerCase().trim() ===
            email.toLowerCase().trim(),
        );
        if (match?.salesperson_id) {
          console.log('[ZohoBooks] Match by email:', match.salesperson_id);
          return match.salesperson_id;
        }
      }

      // Try name
      const matchByName = list.find(
        (sp: any) =>
          sp.salesperson_name?.toLowerCase().trim() ===
          name.toLowerCase().trim(),
      );
      if (matchByName?.salesperson_id) {
        console.log('[ZohoBooks] Match by name:', matchByName.salesperson_id);
        return matchByName.salesperson_id;
      }

      return null;
    } catch (err: any) {
      console.warn('[ZohoBooks] Could not fetch salespersons list:', err.message);
      return null;
    }
  }
}
