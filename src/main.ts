import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // ✅ Disable default parser (IMPORTANT)
  });

  // 🔐 Security
  app.use(helmet());

  // ✅ Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 🌍 CORS
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const config = new DocumentBuilder()
    .setTitle('My API')
    .setDescription('Interactive API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  // 🔥 CRITICAL: RAW BODY for Zoho webhooks ONLY
  app.use('/payments/webhook', bodyParser.raw({ type: '*/*' }));
  app.use('/payments/webhook-sales-doc', bodyParser.raw({ type: '*/*' }));
  app.use('/sales-auth/salesperson/payments/webhook-sales-doc', bodyParser.raw({ type: '*/*' }));
  app.use('/sales-auth/salesperson/sales-orders/payments/webhook', bodyParser.raw({ type: '*/*' }));

  // ✅ Normal JSON parser for all other routes
  app.use(bodyParser.json());

  const port = Number(process.env.BACKEND_PORT ?? 3002);
  console.log(`[Nest] Starting on port ${port}`);
  await app.listen(port);
}

bootstrap();
