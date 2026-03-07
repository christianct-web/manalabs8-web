import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUrgency(urgency = '') {
  const raw = String(urgency).trim().toLowerCase();
  if (!raw) return { label: 'asap', css: 'urgency-asap' };

  if (raw.includes('30')) return { label: 'next 30 days', css: 'urgency-30days' };
  if (raw.includes('explor')) return { label: 'exploring', css: 'urgency-exploring' };
  if (raw.includes('enterprise')) return { label: 'enterprise rfq', css: 'urgency-enterprise' };
  return { label: raw, css: 'urgency-asap' };
}

async function hubspotRequest(path, options = {}) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN missing');

  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HubSpot API ${res.status}: ${errText}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function upsertHubSpotContact({ firstName, lastName, email, whatsapp, company }) {
  const createPayload = {
    properties: {
      email,
      firstname: firstName,
      lastname: lastName,
      phone: whatsapp || '',
      company: company || '',
      lifecyclestage: 'lead',
    },
  };

  try {
    const created = await hubspotRequest('/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify(createPayload),
    });
    return created?.id;
  } catch (err) {
    if (!String(err.message).includes('409')) throw err;

    const search = await hubspotRequest('/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        limit: 1,
        properties: ['email'],
      }),
    });

    const contactId = search?.results?.[0]?.id;
    if (!contactId) throw new Error('Contact exists but lookup failed');

    await hubspotRequest(`/crm/v3/objects/contacts/${contactId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: {
          firstname: firstName,
          lastname: lastName,
          phone: whatsapp || '',
          company: company || '',
        },
      }),
    });

    return contactId;
  }
}

async function createHubSpotNote(contactId, { sector, urgency, problem, submittedLabel }) {
  const body = [
    `New website lead`,
    `Sector: ${sector || 'not specified'}`,
    `Urgency: ${urgency || 'asap'}`,
    `Submitted: ${submittedLabel}`,
    ``,
    `Problem/Bottleneck:`,
    `${problem || ''}`,
  ].join('\n');

  await hubspotRequest('/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: body,
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        },
      ],
    }),
  });
}

async function createHubSpotDealAndTask(contactId, { firstName, lastName, company, urgency }) {
  const pipeline = process.env.HUBSPOT_PIPELINE_ID || 'default';
  const stage = process.env.HUBSPOT_DEALSTAGE_ID || 'appointmentscheduled';

  const deal = await hubspotRequest('/crm/v3/objects/deals', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        dealname: `${company || `${firstName} ${lastName}`} - Discovery Opportunity`,
        pipeline,
        dealstage: stage,
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        },
      ],
    }),
  });

  const due = Date.now() + 15 * 60 * 1000;

  await hubspotRequest('/crm/v3/objects/tasks', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_task_subject: `Follow up new lead (${urgency || 'asap'})`,
        hs_task_body: 'Respond to this lead and attempt discovery booking.',
        hs_timestamp: new Date(due).toISOString(),
        hs_task_status: 'NOT_STARTED',
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }],
        },
        {
          to: { id: deal?.id },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }],
        },
      ],
    }),
  });

  return deal?.id;
}

async function pushToHubSpot(payload) {
  if (!process.env.HUBSPOT_ACCESS_TOKEN) {
    return { enabled: false };
  }

  const contactId = await upsertHubSpotContact(payload);
  await createHubSpotNote(contactId, payload);
  const dealId = await createHubSpotDealAndTask(contactId, payload);

  return { enabled: true, contactId, dealId: dealId || null };
}

export default async function handler(req, res) {
  const allowedOrigin = 'https://manalabs8.com';
  const requestOrigin = req.headers.origin;

  if (requestOrigin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Server not configured (missing RESEND_API_KEY)' });
  }

  const {
    firstName,
    lastName,
    email,
    whatsapp,
    company,
    sector,
    problem,
    urgency,
    submittedAt,
  } = req.body || {};

  if (!firstName || !lastName || !email || !company || !problem) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['firstName', 'lastName', 'email', 'company', 'problem'],
    });
  }

  const safeFirstName = escapeHtml(firstName);
  const safeLastName = escapeHtml(lastName);
  const safeEmail = escapeHtml(email);
  const safeWhatsapp = escapeHtml(whatsapp || '');
  const safeCompany = escapeHtml(company);
  const safeSector = escapeHtml(sector || 'not specified');
  const safeProblem = escapeHtml(problem).replace(/\n/g, '<br>');

  const urgencyInfo = normalizeUrgency(urgency);
  const safeUrgency = escapeHtml(urgencyInfo.label);

  const submittedDate = submittedAt ? new Date(submittedAt) : new Date();
  const submittedLabel = Number.isNaN(submittedDate.getTime())
    ? new Date().toLocaleString('en-TT', { timeZone: 'America/Port_of_Spain' })
    : submittedDate.toLocaleString('en-TT', {
        timeZone: 'America/Port_of_Spain',
        dateStyle: 'full',
        timeStyle: 'short',
      });

  try {
    const { data, error } = await resend.emails.send({
      from: 'Mana Labs 8 <leads@manalabs8.com>',
      to: ['sales@manalabs8.com'],
      replyTo: email,
      subject: `[New Lead] ${firstName} ${lastName} — ${company}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #0a0f0e; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #00c9a7 0%, #00e6be 100%); color: #080d0c; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0.04em; }
            .content { background: #ffffff; padding: 30px; border: 1px solid #e8edea; border-top: none; border-radius: 0 0 8px 8px; }
            .field { margin-bottom: 20px; }
            .field-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #8faaa4; font-weight: 600; margin-bottom: 5px; }
            .field-value { font-size: 16px; color: #0a0f0e; font-weight: 500; }
            .problem-box { background: #f5f9f8; border-left: 3px solid #00c9a7; padding: 15px; margin-top: 10px; border-radius: 4px; }
            .urgency-badge { display: inline-block; padding: 6px 12px; border-radius: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; }
            .urgency-asap { background: #e05252; color: #ffffff; }
            .urgency-30days { background: #e8a325; color: #080d0c; }
            .urgency-exploring { background: #00c9a7; color: #080d0c; }
            .urgency-enterprise { background: #162220; color: #00c9a7; border: 1px solid #00c9a7; }
            .footer { text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e8edea; color: #8faaa4; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎯 New Discovery Call Request</h1>
            </div>
            <div class="content">
              <div class="field">
                <div class="field-label">Contact Name</div>
                <div class="field-value">${safeFirstName} ${safeLastName}</div>
              </div>

              <div class="field">
                <div class="field-label">Email</div>
                <div class="field-value"><a href="mailto:${safeEmail}" style="color: #00c9a7; text-decoration: none;">${safeEmail}</a></div>
              </div>

              ${safeWhatsapp ? `
              <div class="field">
                <div class="field-label">WhatsApp</div>
                <div class="field-value">${safeWhatsapp}</div>
              </div>
              ` : ''}

              <div class="field">
                <div class="field-label">Company</div>
                <div class="field-value">${safeCompany}</div>
              </div>

              <div class="field">
                <div class="field-label">Sector</div>
                <div class="field-value">${safeSector}</div>
              </div>

              <div class="field">
                <div class="field-label">Timeline</div>
                <div class="field-value">
                  <span class="urgency-badge ${urgencyInfo.css}">${safeUrgency}</span>
                </div>
              </div>

              <div class="field">
                <div class="field-label">Problem / Bottleneck</div>
                <div class="problem-box">${safeProblem}</div>
              </div>

              <div class="field">
                <div class="field-label">Submitted At</div>
                <div class="field-value">${escapeHtml(submittedLabel)}</div>
              </div>
            </div>
            <div class="footer">
              <p>📍 Trinidad & Tobago · Mana Labs 8</p>
              <p>Reply directly to this email to contact ${safeFirstName}</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
New Discovery Call Request from Mana Labs 8

Name: ${firstName} ${lastName}
Email: ${email}
WhatsApp: ${whatsapp || 'Not provided'}
Company: ${company}
Sector: ${sector || 'not specified'}
Timeline: ${urgencyInfo.label}

Problem / Bottleneck:
${problem}

Submitted: ${submittedLabel}

---
Reply to this email to contact ${firstName} directly.
      `,
    });

    if (error) {
      console.error('Resend API error:', error);
      return res.status(400).json({ error: error.message || 'Failed to send email' });
    }

    let hubspot = { enabled: false };
    try {
      hubspot = await pushToHubSpot({
        firstName,
        lastName,
        email,
        whatsapp,
        company,
        sector,
        urgency: urgencyInfo.label,
        problem,
        submittedLabel,
      });
    } catch (hsErr) {
      console.error('HubSpot sync failed (non-blocking):', hsErr?.message || hsErr);
    }

    return res.status(200).json({
      success: true,
      emailId: data?.id,
      message: 'Email sent successfully',
      hubspot,
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error?.message || 'Unknown error',
    });
  }
}
