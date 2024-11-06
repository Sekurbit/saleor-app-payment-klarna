import { type TransactionInitializeSessionResponse } from "@/schemas/TransactionInitializeSession/TransactionInitializeSessionResponse.mjs";
import {
  type OrderOrCheckoutLinesFragment,
  type TransactionInitializeSessionEventFragment,
} from "generated/graphql";
import { env } from "@/lib/env.mjs";
import { createLogger } from "@/lib/logger";
import { invariant } from "@/lib/invariant";
import { getWebhookPaymentAppConfigurator } from "@/modules/payment-app-configuration/payment-app-configuration-factory";
import { paymentAppFullyConfiguredEntrySchema } from "@/modules/payment-app-configuration/config-entry";
import { getConfigurationForChannel } from "@/modules/payment-app-configuration/payment-app-configuration";
import {
  calculateTaxRate,
  getKlarnaApiClient,
  type KlarnaMetadata,
  prepareRequestAddress,
} from "@/modules/klarna/klarna-api";
import { type components as checkoutComponents } from "generated/klarna-checkout";
import { getKlarnaIntegerAmountFromSaleor } from "@/modules/klarna/currencies";
import { KlarnaHttpClientError } from "@/errors";

/*const transactionInitializePayloadData = z.object({
  merchantUrls: z.object({
    success: z.string().url(),
    cancel: z.string().url().optional(),
    back: z.string().url().optional(),
    failure: z.string().url().optional(),
    error: z.string().url().optional(),
  }),
});*/

export const TransactionInitializeSessionWebhookHandler = async (
  event: TransactionInitializeSessionEventFragment,
  { saleorApiUrl, baseUrl }: { saleorApiUrl: string; baseUrl: string },
): Promise<TransactionInitializeSessionResponse> => {
  const appBaseUrl = env.APP_API_BASE_URL ?? baseUrl;

  const logger = createLogger(
    { saleorApiUrl },
    { msgPrefix: "[TransactionInitializeSessionWebhookHandler] " },
  );
  const { transaction, action, sourceObject, merchantReference, issuingPrincipal } = event;
  const { id, __typename, channel } = sourceObject;
  const logData = {
    transaction,
    action,
    sourceObject: { id, channel, __typename },
    merchantReference,
    issuingPrincipal,
  };
  logger.debug(logData, "Received event");

  const app = event.recipient;
  invariant(app, "Missing event.recipient!");
  invariant(event.data, "Missing data");

  //const { merchantUrls } = transactionInitializePayloadData.parse(event.data);

  const { privateMetadata } = app;

  const configurator = getWebhookPaymentAppConfigurator({ privateMetadata }, saleorApiUrl);
  const appConfig = await configurator.getConfig();
  const klarnaConfig = paymentAppFullyConfiguredEntrySchema.parse(
    getConfigurationForChannel(appConfig, event.sourceObject.channel.id),
  );

  const klarnaClient = getKlarnaApiClient({
    klarnaApiUrl: klarnaConfig.apiUrl,
    username: klarnaConfig.username,
    password: klarnaConfig.password,
  });

  const createKlarnaCheckout = klarnaClient.path("/checkout/v3/orders").method("post").create();

  //const locale = getNormalizedLocale(event);

  const country = event.sourceObject.billingAddress?.country.code;
  invariant(country, "Missing country code");

  const transactionId = event.transaction.id;
  const channelId = event.sourceObject.channel.id;

  const metadata: KlarnaMetadata = {
    transactionId,
    channelId,
    ...(event.sourceObject.__typename === "Checkout" && { checkoutId: event.sourceObject.id }),
    ...(event.sourceObject.__typename === "Order" && { orderId: event.sourceObject.id }),
  };

  const orderLines = getLineItems(event.sourceObject);
  const orderTaxAmount = orderLines.reduce((acc, line) => acc + (line.total_tax_amount ?? 0), 0);

  const authorizationCallbackUrl = new URL(appBaseUrl);
  authorizationCallbackUrl.pathname = "/api/webhooks/klarna/checkout/authorization";
  authorizationCallbackUrl.searchParams.set("transactionId", transactionId);
  authorizationCallbackUrl.searchParams.set("channelId", channelId);
  authorizationCallbackUrl.searchParams.set("saleorApiUrl", saleorApiUrl);

  const email = sourceObject.userEmail;
  const createKlarnaCheckoutPayload: checkoutComponents["schemas"]["order"] = {
    locale: "sv-SE", //locale.split("_")[0],
    purchase_country: country,
    purchase_currency: event.action.currency,
    billing_address: prepareRequestAddress(sourceObject.billingAddress, email),
    shipping_address: prepareRequestAddress(sourceObject.shippingAddress, email),
    order_amount: getKlarnaIntegerAmountFromSaleor(event.action.amount, event.action.currency),
    order_tax_amount: orderTaxAmount,
    order_lines: orderLines,
    merchant_reference1: event.transaction.id,
    merchant_reference2: event.sourceObject.id,
    merchant_data: JSON.stringify(metadata),
    merchant_urls: {
      terms: "https://www.dalecarliacrew.se/terms",
      checkout: "http://localhost:3001/checkout",
      confirmation: "http://localhost:3001/confirmation",
      push: "http://localhost:3001/push",
      //authorization: authorizationCallbackUrl.toString(),
    },
  };

  logger.info(authorizationCallbackUrl.toString());
  logger.debug({ ...createKlarnaCheckoutPayload }, "Klarna checkout payload");

  const klarnaCheckout = await createKlarnaCheckout(createKlarnaCheckoutPayload);

  logger.debug({ ...klarnaCheckout }, "klarnaCheckout result");

  if (!klarnaCheckout.ok) {
    throw new KlarnaHttpClientError(klarnaCheckout.statusText, { errors: [klarnaCheckout.data] });
  }

  // TODO: Continue!

  const transactionInitializeSessionResponse: TransactionInitializeSessionResponse = {
    data: {
      klarnaHppResponse: {
        redirectUrl: "",
      },
    },
    result: "AUTHORIZATION_ACTION_REQUIRED",
    actions: [],
    amount: 0,
    /*data: {
      klarnaHppResponse: {
        redirectUrl: klarnaHpp.data.redirect_url,
      },
    },
    pspReference: klarnaHpp.data.session_id,
    result:
      event.action.actionType === TransactionFlowStrategyEnum.Authorization
        ? "AUTHORIZATION_ACTION_REQUIRED"
        : "CHARGE_ACTION_REQUIRED",
    actions: [],
    amount: action.amount,
    message: "",
    externalUrl: klarnaHpp.data.session_url,*/
  };
  return transactionInitializeSessionResponse;
};

export const getLineItems = ({
  lines,
  shippingPrice,
  deliveryMethod,
}: {
  lines: OrderOrCheckoutLinesFragment["lines"];
  shippingPrice?: OrderOrCheckoutLinesFragment["shippingPrice"];
  deliveryMethod?: OrderOrCheckoutLinesFragment["deliveryMethod"];
}): checkoutComponents["schemas"]["order_line"][] => {
  const shippingLineItem: checkoutComponents["schemas"]["order_line"] | null =
    shippingPrice && deliveryMethod?.__typename === "ShippingMethod"
      ? {
          type: "shipping_fee",
          reference: deliveryMethod.id,
          name: deliveryMethod.name,
          quantity: 1,
          unit_price: getKlarnaIntegerAmountFromSaleor(
            shippingPrice.gross.amount,
            shippingPrice.gross.currency,
          ),
          total_amount: getKlarnaIntegerAmountFromSaleor(
            shippingPrice.gross.amount,
            shippingPrice.gross.currency,
          ),
          total_tax_amount: getKlarnaIntegerAmountFromSaleor(
            shippingPrice.tax.amount,
            shippingPrice.tax.currency,
          ),
          tax_rate: calculateTaxRate(shippingPrice.tax.amount, shippingPrice.net.amount),
        }
      : null;

  const lineItems = lines.map((line) => {
    const variant =
      line.__typename === "CheckoutLine"
        ? line.checkoutVariant
        : line.__typename === "OrderLine"
        ? line.orderVariant
        : /* c8 ignore next */
          null;

    invariant(variant, `Unknown line type: ${line.__typename || "<undefined>"}`);

    const klarnaLineItem: checkoutComponents["schemas"]["order_line"] = {
      type: line.requiresShipping ? "physical" : "digital",
      reference: variant.sku || variant.id,
      name: variant.product.name + " - " + variant.name,
      quantity: line.quantity,
      image_url: variant.product.thumbnail?.url,
      unit_price: getKlarnaIntegerAmountFromSaleor(
        line.unitPrice.gross.amount,
        line.unitPrice.gross.currency,
      ),
      total_amount: getKlarnaIntegerAmountFromSaleor(
        line.totalPrice.gross.amount,
        line.totalPrice.gross.currency,
      ),
      total_tax_amount: getKlarnaIntegerAmountFromSaleor(
        line.totalPrice.tax.amount,
        line.totalPrice.tax.currency,
      ),
      tax_rate: calculateTaxRate(line.totalPrice.tax.amount, line.totalPrice.net.amount),
    };
    return klarnaLineItem;
  });

  return [...lineItems, shippingLineItem].filter(Boolean);
};
