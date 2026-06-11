import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ZohoToken } from '../schemas/zoho-token.schema';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import type { ZohoService } from '../config/zoho-scope.config';

@Injectable()
export class ZohoAuthService {
  constructor(
    @InjectModel(ZohoToken.name)
    private readonly tokenModel: Model<ZohoToken>,
    private readonly configService: ConfigService,
  ) {}

  // 🔥 EXCHANGE CODE → TOKEN
  async exchangeCodeForToken(code: string, service: ZohoService) {
    const clientId = this.configService.getOrThrow<string>('ZOHO_CLIENT_ID');
    const clientSecret =
      this.configService.getOrThrow<string>('ZOHO_CLIENT_SECRET');
    const redirectUri =
      this.configService.getOrThrow<string>('ZOHO_REDIRECT_URI');

    try {
      console.log('[DEBUG] ZohoAuthService exchange request parameters:', {
        clientId: clientId ? `${clientId.substring(0, 8)}...` : 'undefined',
        clientSecretExists: !!clientSecret,
        redirectUri,
        code: code ? `${code.substring(0, 12)}...` : 'undefined',
        service,
      });

      const response = await fetch('https://accounts.zoho.in/oauth/v2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        }),
      });

      const data = await response.json();
      console.log('[DEBUG] ZohoAuthService exchange response status:', response.status, 'data:', data);

      if (!response.ok || data.error) {
        throw new Error(data.error || 'Zoho token exchange failed');
      }

      await this.tokenModel.findOneAndUpdate(
        { service },
        {
          service,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
        },
        { upsert: true, new: true },
      );

      return data;
    } catch (error: any) {
      console.error('Zoho exchange error:', error);
      throw new InternalServerErrorException('Zoho token exchange failed');
    }
  }

  // 🔥 GET VALID TOKEN
  async getValidAccessToken(service: ZohoService): Promise<string> {
    const tokenDoc = await this.tokenModel
      .findOne({ service })
      .lean<ZohoToken>();

    if (!tokenDoc) {
      throw new InternalServerErrorException(
        `Zoho token not found for ${service}`,
      );
    }

    // ⏳ refresh if expiring
    if (Date.now() >= tokenDoc.expires_at - 60000) {
      return this.refreshAndUpdateToken(service, tokenDoc.refresh_token);
    }

    return tokenDoc.access_token;
  }

  // 🔥 REFRESH + UPDATE (SAFE)
  private async refreshAndUpdateToken(
    service: ZohoService,
    refreshToken: string,
  ): Promise<string> {
    try {
      const newToken = await this.refreshAccessToken(refreshToken);

      await this.tokenModel.updateOne(
        { service },
        {
          access_token: newToken.access_token,
          expires_at: Date.now() + newToken.expires_in * 1000,
          refresh_token: newToken.refresh_token || refreshToken, // 🔥 keep old
        },
      );

      return newToken.access_token;
    } catch (error) {
      console.error('Zoho refresh error:', error);
      throw new InternalServerErrorException('Zoho token refresh failed');
    }
  }

  // 🔥 REFRESH TOKEN
  private async refreshAccessToken(refreshToken: string) {
    const clientId = this.configService.getOrThrow<string>('ZOHO_CLIENT_ID');
    const clientSecret =
      this.configService.getOrThrow<string>('ZOHO_CLIENT_SECRET');

    const response = await fetch('https://accounts.zoho.in/oauth/v2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Zoho refresh failed');
    }

    return data;
  }

  // 🔥 OPTIONAL: AUTH URL GENERATOR (KEEP HERE)
  getAuthUrl(service: ZohoService) {
    const scopeMap = {
      crm: 'ZohoCRM.modules.ALL',
      inventory: 'ZohoInventory.fullaccess.all',
      payments: 'ZohoPay.payments.CREATE',
      books: 'ZohoBooks.fullaccess.all',
    };

    const clientId = this.configService.getOrThrow<string>('ZOHO_CLIENT_ID');
    const redirectUri =
      this.configService.getOrThrow<string>('ZOHO_REDIRECT_URI');

    return `https://accounts.zoho.in/oauth/v2/auth?scope=${scopeMap[service]}&client_id=${clientId}&response_type=code&access_type=offline&redirect_uri=${redirectUri}&state=${service}`;
  }
}
