/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Sentry from "@sentry/nextjs";
import { acceptedLanguages, negotiateLanguages } from "@fluent/langneg";
import { localStorage } from "../../utils/localStorage.js";

import * as pubsub from "@google-cloud/pubsub";
import * as grpc from "@grpc/grpc-js";
import type { SubscriberClient } from "@google-cloud/pubsub/build/src/v1/subscriber_client.js";
import type { EmailAddressRow, SubscriberRow } from "knex/types/tables";

import {
  getSubscribersByHashes,
  knexSubscribers,
} from "../../db/tables/subscribers.js";
import {
  getEmailAddressesByHashes,
  knexEmailAddresses,
} from "../../db/tables/emailAddresses.js";
import {
  getNotifiedSubscribersForBreach,
  addEmailNotification,
  markEmailAsNotified,
} from "../../db/tables/email_notifications.js";
import { getTemplate } from "../../emails/email2022.js";
import { breachAlertEmailPartial } from "../../emails/emailBreachAlert.js";
import {
  initEmail,
  EmailTemplateType,
  getEmailCtaDashboardHref,
  sendEmail,
} from "../../utils/email.js";

import { initFluentBundles, getMessage } from "../../utils/fluent.js";
import {
  getAddressesAndLanguageForEmail,
  getBreachByName,
  getAllBreachesFromDb,
  knexHibp,
} from "../../utils/hibp";

const SENTRY_SLUG = "cron-breach-alerts";

Sentry.init({
  environment: process.env.APP_ENV,
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

const checkInId = Sentry.captureCheckIn({
  monitorSlug: SENTRY_SLUG,
  status: "in_progress",
});

// Only process this many messages before exiting.
/* c8 ignore start */
const maxMessages = parseInt(
  process.env.EMAIL_BREACH_ALERT_MAX_MESSAGES ?? "10000",
  10,
);
/* c8 ignore stop */
const projectId = process.env.GCP_PUBSUB_PROJECT_ID;
const subscriptionName = process.env.GCP_PUBSUB_SUBSCRIPTION_NAME;

/**
 * Fetch the latest HIBP breach data from GCP PubSub queue.
 *
 * A breach notification contains the following parameters:
 * - breachName
 * - hashPrefix
 * - hashSuffixes
 *
 * More about how account identities are anonymized: https://blog.mozilla.org/security/2018/06/25/scanning-breached-accounts-k-anonymity/
 */
export async function poll(
  subClient: SubscriberClient,
  receivedMessages: Array<{
    ackId?: string | null;
    deliveryAttempt?: number | null;
    message?: {
      messageId?: string | null;
      orderingKey?: string | undefined | null;
      data?: string | Uint8Array | null;
    } | null;
  }>,
) {
  // These env vars are always set in tests:
  /* c8 ignore next 8 */
  if (!projectId) {
    throw new Error("Environment variable [$GCP_PUBSUB_PROJECT_ID] not set.");
  }
  if (!subscriptionName) {
    throw new Error(
      "Environment variable [$GCP_PUBSUB_SUBSCRIPTION_NAME] not set.",
    );
  }
  const formattedSubscription = subClient.subscriptionPath(
    projectId,
    subscriptionName,
  );

  const breaches = await getAllBreachesFromDb();

  // Process the messages. Skip any that cannot be processed, and do not mark as acknowledged.
  for (const message of receivedMessages) {
    console.log(`Received message: ${message.message?.data}`);
    const data = JSON.parse(message.message?.data as string) as {
      breachName: string;
      hashPrefix: string;
      hashSuffixes: string[];
    };

    if (!(data.breachName && data.hashPrefix && data.hashSuffixes)) {
      console.error(
        "HIBP breach notification: requires breachName, hashPrefix, and hashSuffixes.",
      );
      continue;
    }

    const { breachName, hashPrefix, hashSuffixes } = data;
    const breachAlert = getBreachByName(breaches, breachName);
    // Check added to old code for type safety, but we've been assuming
    // getBreachByName will always find a breach here without tests so far, so
    // apparently that's been working well enough:
    /* c8 ignore next 6 */
    if (!breachAlert) {
      console.error(
        "HIBP breach notification: couldn't find the breach to notify about.",
      );
      continue;
    }

    const {
      IsVerified,
      Domain,
      IsFabricated,
      IsSpamList,
      Id: breachId,
    } = breachAlert;

    // If any of the following conditions are not satisfied:
    // Do not send the breach alert email! The `logId`s are being used for
    // logging in case we decide to not send the alert.
    const emailDeliveryConditions = [
      {
        logId: "isNotVerified",
        condition: !IsVerified,
      },
      {
        logId: "domainEmpty",
        condition: Domain === "",
      },
      {
        logId: "isFabricated",
        condition: IsFabricated,
      },
      {
        logId: "isSpam",
        condition: IsSpamList,
      },
    ];

    const unsatisfiedConditions = emailDeliveryConditions.filter(
      (condition) => condition.condition,
    );

    const doNotSendEmail = unsatisfiedConditions.length > 0;

    if (doNotSendEmail) {
      // Get a list of the failed condition `logId`s
      const conditionLogIds = unsatisfiedConditions
        .map((condition) => condition.logId)
        .join(", ");

      console.info("Breach alert email was not sent.", {
        name: breachAlert.Name,
        reason: `The following conditions were not satisfied: ${conditionLogIds}.`,
      });

      subClient.acknowledge({
        subscription: formattedSubscription,
        ackIds:
          typeof message.ackId === "string"
            ? [message.ackId]
            : /* c8 ignore next 4 */
              // When porting this code to TypeScript, the undefined/null case
              // wasn't dealt with, so presumably our messages always have an
              // ackId:
              message.ackId,
      });

      continue;
    }

    try {
      const reqHashPrefix = hashPrefix.toLowerCase();
      const hashes = hashSuffixes.map(
        (suffix) => reqHashPrefix + suffix.toLowerCase(),
      );

      const subscribers = await getSubscribersByHashes(hashes);
      const emailAddresses = await getEmailAddressesByHashes(hashes);
      const recipients: Array<
        SubscriberRow | (SubscriberRow & EmailAddressRow)
      > = subscribers.concat(emailAddresses);

      console.info(EmailTemplateType.Notification, {
        breachAlertName: breachAlert.Name,
        length: recipients.length,
      });

      const utmCampaignId = "breach-alert";
      const notifiedRecipients: string[] = [];

      for (const recipient of recipients) {
        console.info("notify", { recipient });

        const notifiedSubs = await getNotifiedSubscribersForBreach(breachId);

        // Get subscriber ID from:
        // - `subscriber_id`: if `email_addresses` record
        // - `id`: if `subscribers` record
        /* c8 ignore next 4 */
        // TODO: Add unit test when changing this code:
        const subscriberId = hasEmailAddressAttached(recipient)
          ? recipient.subscriber_id
          : recipient.id;
        if (notifiedSubs.includes(subscriberId)) {
          console.info("Subscriber already notified, skipping: ", subscriberId);
          continue;
        }
        const { recipientEmail, breachedEmail, signupLanguage } =
          getAddressesAndLanguageForEmail(recipient);

        /* c8 ignore start */
        const requestedLanguage = signupLanguage
          ? acceptedLanguages(signupLanguage)
          : [];
        /* c8 ignore stop */

        const availableLanguages = process.env.SUPPORTED_LOCALES!.split(",");
        const supportedLocales = negotiateLanguages(
          requestedLanguage,
          availableLanguages,
          { defaultLocale: "en" },
        );

        await localStorage.run(new Map(), async () => {
          localStorage.getStore().set("locale", supportedLocales);
          await (async () => {
            if (!notifiedRecipients.includes(breachedEmail)) {
              const data = {
                breachData: breachAlert,
                breachedEmail,
                ctaHref: getEmailCtaDashboardHref({
                  emailType: utmCampaignId,
                  content: "dashboard-cta",
                  dashboardTabType: "action-needed",
                }),
                heading: getMessage("email-spotted-new-breach"),
                recipientEmail,
                subscriberId,
                supportedLocales,
                utmCampaign: utmCampaignId,
              };

              // try to append a new row into the email notifications table
              // if the append fails, there might be already an entry, stop the script
              try {
                await addEmailNotification({
                  breachId,
                  subscriberId,
                  notified: false,
                  email: data.recipientEmail,
                  notificationType: "incident",
                });

                const emailTemplate = getTemplate(
                  data,
                  breachAlertEmailPartial,
                );
                const subject = getMessage("breach-alert-subject");

                await sendEmail(data.recipientEmail, subject, emailTemplate);
              } catch (e) {
                console.error("Failed to add email notification to table: ", e);
                setTimeout(process.exit, 1000);
              }

              // mark email as notified in database
              // if this call ever fails, stop stop the script with an error
              try {
                await markEmailAsNotified(
                  subscriberId,
                  breachId,
                  data.recipientEmail,
                );
              } catch (e: any) {
                console.error("Failed to mark email as notified: ", e);
                throw new Error(e);
              }
              notifiedRecipients.push(breachedEmail);
            }
          })();
        });
      }

      console.info("notified", { length: notifiedRecipients.length });

      subClient.acknowledge({
        subscription: formattedSubscription,
        ackIds:
          typeof message.ackId === "string"
            ? [message.ackId]
            : /* c8 ignore next 4 */
              // When porting this code to TypeScript, the undefined/null case
              // wasn't dealt with, so presumably our messages always have an
              // ackId:
              message.ackId,
      });
      /* c8 ignore start */
    } catch (error) {
      console.error(`Notifying subscribers of breach failed: ${error}`);
    }
    /* c8 ignore stop */
  }
}

/* c8 ignore start */
async function pullMessages() {
  let options = {};
  if (process.env.NODE_ENV === "development") {
    console.debug("Dev mode, connecting to local pubsub emulator");
    options = {
      servicePath: "localhost",
      port: "8085",
      sslCreds: grpc.credentials.createInsecure(),
    };
  }
  // These env vars are always set in tests:
  /* c8 ignore next 8 */
  if (!projectId) {
    throw new Error("Environment variable [$GCP_PUBSUB_PROJECT_ID] not set.");
  }
  if (!subscriptionName) {
    throw new Error(
      "Environment variable [$GCP_PUBSUB_SUBSCRIPTION_NAME] not set.",
    );
  }

  const subClient = new pubsub.v1.SubscriberClient(options);

  const formattedSubscription = subClient.subscriptionPath(
    projectId,
    subscriptionName,
  );

  // If there are no messages, this will wait until the default timeout for the pull API.
  // @see https://cloud.google.com/pubsub/docs/pull
  console.debug("polling pubsub...");
  const [response] = await subClient.pull({
    subscription: formattedSubscription,
    maxMessages,
  });

  return [subClient, response.receivedMessages] as const;
}
async function init() {
  await initFluentBundles();
  await initEmail();

  const [subClient, receivedMessages] = await pullMessages();
  await poll(subClient, receivedMessages ?? []);
}

if (process.env.NODE_ENV !== "test") {
  init()
    .then(async (_res) => {
      if (!(projectId && subscriptionName)) {
        throw new Error(
          "env vars not set: GCP_PUBSUB_PROJECT_ID and GCP_PUBSUB_SUBSCRIPTION_NAME",
        );
      }
    })
    .catch((err) => console.error(err))
    .finally(async () => {
      // Tear down knex connection pools
      await knexSubscribers.destroy();
      await knexEmailAddresses.destroy();
      await knexHibp.destroy();
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: SENTRY_SLUG,
        status: "ok",
      });
      setTimeout(process.exit, 1000);
    });
}
/* c8 ignore stop */

function hasEmailAddressAttached(
  row: SubscriberRow | (SubscriberRow & EmailAddressRow),
): row is SubscriberRow & EmailAddressRow {
  return typeof (row as EmailAddressRow).subscriber_id !== "undefined";
}
