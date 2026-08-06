/**
 * lib/auth/channel.ts — how an activation token reaches a resident.
 *
 * **ADR-016, approved by the owner on 2026-08-04.** WhatsApp Cloud API is OUT of
 * v1. Meta begins billing for service messages on 2026-10-01 with no free
 * allowance, and ADR-011 had already reduced WhatsApp to roughly one use per
 * resident, ever. Board-issued one-time links do the same job, cost nothing,
 * need no vendor, and — the part that actually mattered — remove Meta business
 * verification, which was the longest-lead-time task in the whole project.
 *
 * The board member generates a link in the admin panel and sends it from their
 * OWN ordinary WhatsApp, exactly as they already message residents today.
 *
 * Every channel below sits behind one interface so reinstating WhatsApp later is
 * a config change, not a rewrite. (C11: no vendor API leaks past its adapter.)
 */

export interface ActivationChannel {
  readonly id: 'board_link' | 'printed' | 'console' | 'whatsapp_inbound';
  readonly enabled: boolean;
  /** Returns what the BOARD MEMBER sees — never what the resident receives, because
   *  with a board link there is no automated delivery at all. */
  prepare(input: { fullName: string; token: string; baseUrl: string }):
    Promise<{ shareText: string; url: string; instructionsAr: string }>;
}

/** THE PRIMARY PATH (ADR-016). Zero infrastructure, zero vendor, zero quota. */
export const BoardLinkChannel: ActivationChannel = {
  id: 'board_link',
  enabled: true,
  async prepare({ fullName, token, baseUrl }) {
    const url = `${baseUrl}/login/activate?t=${token}`;
    return {
      url,
      shareText:
        `أهلاً ${fullName} 👋\n` +
        `ده لينك تفعيل حسابك في بوابة قرية الأطباء:\n${url}\n\n` +
        `اضغط عليه من الموبايل، وهيطلبلك تسجّل بصمتك مرة واحدة بس — ` +
        `وبعد كده هتدخل بلمسة واحدة من غير أي كود.\n` +
        `اللينك ده يخصك إنت لوحدك وبيقف بعد 24 ساعة.`,
      instructionsAr:
        'انسخ الرسالة دي وابعتها للساكن من الواتساب العادي بتاعك. ' +
        'متبعتهاش في جروب — اللينك ده بيفتح حساب الشخص ده بالذات.',
    };
  },
};

/** For a resident with no smartphone at all. The security desk hands over paper.
 *  Unglamorous, free, and it means nobody is excluded. (05 §3 fallback 3) */
export const PrintedCodeChannel: ActivationChannel = {
  id: 'printed',
  enabled: true,
  async prepare({ fullName, token }) {
    return {
      url: '',
      shareText: `قرية الأطباء — تفعيل حساب ${fullName}\nكود التفعيل: ${token}`,
      instructionsAr: 'اطبع الورقة دي وسلّمها للساكن باليد بعد التأكد من شخصيته.',
    };
  },
};

/** Dev only. Prints to the terminal so CP-0…CP-4 are fully testable at zero spend. */
export const ConsoleChannel: ActivationChannel = {
  id: 'console',
  enabled: true,
  async prepare({ fullName, token, baseUrl }) {
    const url = `${baseUrl}/login/activate?t=${token}`;
    // eslint-disable-next-line no-console
    console.log(`[activation] ${fullName} -> ${url}`);
    return { url, shareText: url, instructionsAr: 'dev only' };
  },
};

/**
 * DISABLED. Retained so the design is not lost and so re-enabling is a config
 * change. Do NOT enable without re-reading ADR-016 and re-checking Meta's rate
 * card — and note that even then the flow must never SEND a message: Meta bills
 * the business for what it sends, inbound from the resident stays free, and the
 * browser page is already polling for the confirmation.
 */
export const WhatsAppInboundChannel: ActivationChannel = {
  id: 'whatsapp_inbound',
  enabled: false,
  async prepare() {
    throw new Error(
      'WhatsApp channel is disabled (ADR-016). Service messages became billable 2026-10-01.',
    );
  },
};

const CHANNELS = [BoardLinkChannel, PrintedCodeChannel, ConsoleChannel, WhatsAppInboundChannel];

export function getChannel(id: ActivationChannel['id']): ActivationChannel {
  const c = CHANNELS.find(x => x.id === id);
  if (!c) throw new Error(`unknown activation channel: ${id}`);
  if (!c.enabled) throw new Error(`activation channel ${id} is disabled`);
  return c;
}

/** Proves the CP-2 gate: the whole activation path works with WhatsApp switched
 *  off entirely, because it is off and always was. */
export function enabledChannels(): string[] {
  return CHANNELS.filter(c => c.enabled).map(c => c.id);
}
