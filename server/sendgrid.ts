import sgMail from '@sendgrid/mail';
import type { Lead } from "@shared/schema";

let connectionSettings: any;

async function getCredentials() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=sendgrid',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.api_key || !connectionSettings.settings.from_email)) {
    throw new Error('SendGrid not connected');
  }
  return { apiKey: connectionSettings.settings.api_key, email: connectionSettings.settings.from_email };
}

export async function getUncachableSendGridClient() {
  const { apiKey, email } = await getCredentials();
  sgMail.setApiKey(apiKey);
  return {
    client: sgMail,
    fromEmail: email
  };
}

export async function sendTestEmail(toEmail: string): Promise<void> {
  const { client, fromEmail } = await getUncachableSendGridClient();
  
  await client.send({
    to: toEmail,
    from: fromEmail,
    subject: 'Lead Intelligence - Test Alert',
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #1a1a2e; margin-bottom: 20px;">Test Alert from Lead Intelligence</h1>
        <p style="color: #666; font-size: 16px; line-height: 1.6;">
          This is a test email to confirm your alert settings are configured correctly.
        </p>
        <p style="color: #666; font-size: 16px; line-height: 1.6;">
          You will receive emails like this when new high-priority leads are found matching your configured keywords.
        </p>
        <div style="margin-top: 30px; padding: 20px; background: #f5f5f5; border-radius: 8px;">
          <p style="margin: 0; color: #888; font-size: 14px;">
            Lead Intelligence Tool - Private Banking SEA Coverage
          </p>
        </div>
      </div>
    `,
    text: 'This is a test email to confirm your alert settings are configured correctly. You will receive emails like this when new high-priority leads are found matching your configured keywords.',
  });
}

export async function sendLeadAlertEmail(toEmail: string, leads: Lead[]): Promise<void> {
  const { client, fromEmail } = await getUncachableSendGridClient();
  
  const leadsHtml = leads.map(lead => `
    <div style="margin-bottom: 24px; padding: 20px; background: #f8f9fa; border-radius: 8px; border-left: 4px solid ${lead.priorityLevel === 'high' ? '#ef4444' : lead.priorityLevel === 'medium' ? '#f59e0b' : '#10b981'};">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <span style="background: ${lead.priorityLevel === 'high' ? '#fef2f2' : lead.priorityLevel === 'medium' ? '#fffbeb' : '#ecfdf5'}; color: ${lead.priorityLevel === 'high' ? '#dc2626' : lead.priorityLevel === 'medium' ? '#d97706' : '#059669'}; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase;">
          ${lead.priorityLevel} Priority
        </span>
        <span style="font-size: 12px; color: #666;">Score: ${lead.priorityScore}</span>
      </div>
      <h3 style="margin: 0 0 8px 0; color: #1a1a2e;">
        <a href="${lead.sourceUrl}" style="color: #2563eb; text-decoration: none;">${lead.headline}</a>
      </h3>
      <div style="font-size: 14px; color: #666; margin-bottom: 8px;">
        <strong>Companies:</strong> ${lead.companyNames.join(', ')}<br>
        <strong>Key People:</strong> ${lead.founderNames.join(', ')}
      </div>
      <p style="margin: 12px 0; color: #444; font-size: 14px; line-height: 1.6;">${lead.aiSummary}</p>
      <div style="font-size: 12px; color: #888;">
        ${lead.sourceName} | ${lead.region} | ${new Date(lead.publishedAt).toLocaleDateString()}
      </div>
    </div>
  `).join('');

  await client.send({
    to: toEmail,
    from: fromEmail,
    subject: `Lead Intelligence Alert - ${leads.length} New Lead${leads.length > 1 ? 's' : ''} Found`,
    html: `
      <div style="font-family: Inter, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1a1a2e; margin: 0;">New Leads Detected</h1>
          <p style="color: #666; margin: 10px 0 0;">Private Banking Lead Intelligence</p>
        </div>
        <p style="color: #444; font-size: 16px; margin-bottom: 24px;">
          We found <strong>${leads.length}</strong> new potential client acquisition ${leads.length > 1 ? 'opportunities' : 'opportunity'} matching your keywords:
        </p>
        ${leadsHtml}
        <div style="margin-top: 40px; padding: 20px; background: #f5f5f5; border-radius: 8px; text-align: center;">
          <p style="margin: 0 0 10px; color: #666; font-size: 14px;">
            View all leads in your dashboard
          </p>
          <p style="margin: 0; color: #888; font-size: 12px;">
            Lead Intelligence Tool - Southeast Asia Coverage
          </p>
        </div>
      </div>
    `,
    text: leads.map(l => `${l.headline}\n${l.companyNames.join(', ')}\n${l.aiSummary}\n---`).join('\n\n'),
  });
}
