/**
 * messaging-binding-form.ts unit tests: the channel-aware form ↔ DTO conversion behind
 * the binding editor. The load-bearing rules are the secret round-trip — secret fields
 * always load empty, an empty submit keeps the stored secret (the PUT body omits it), and
 * only a first bind requires one — the models-idiom clear checkbox (applied on save, a
 * typed secret wins over it), the per-channel submit routing (only the selected channel's
 * fields are validated and sent), the blank-domain-means-default fallback, and the two saved
 * fields that are not credentials — `linePerMessage` and `finalReplyOnly`, which load per
 * channel and are always sent (an omitted flag would mean "keep", leaving no way to turn either
 * option back off).
 */
import { describe, expect, it } from "vitest";
import type {
  FeishuBindingInfo,
  QQBindingInfo,
  TelegramBindingInfo,
  TuituiBindingInfo,
  WeChatBindingInfo,
} from "@prismshadow/penguin-server/api";
import {
  FEISHU_DEFAULT_DOMAIN,
  TUITUI_DEFAULT_HOST,
  bindingsToForm,
  emptyMessagingForm,
  formDirty,
  formTestable,
  formToPut,
  formToTest,
} from "../src/features/messaging/messaging-binding-form";

const STORED_FEISHU: FeishuBindingInfo = {
  channel: "feishu",
  sessionId: "session-1",
  appId: "cli_abc",
  appSecretMasked: "abcd…wxyz",
  baseDomain: "https://open.larksuite.com",
  enabled: false,
  linePerMessage: false,
  finalReplyOnly: false,
  renderMarkdown: true,
  lastChatKnown: true,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const STORED_TELEGRAM: TelegramBindingInfo = {
  channel: "telegram",
  sessionId: "session-1",
  botId: "7000000001",
  botTokenMasked: "7000…1111",
  enabled: true,
  // Set on one fixture only, so a per-channel load cannot pass by copying the other channel.
  linePerMessage: true,
  finalReplyOnly: false,
  // Off on one fixture only, for the same reason — and because ON is the default, so a load
  // that ignored the stored value would still look right on the other two.
  renderMarkdown: false,
  lastChatKnown: false,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const STORED_QQ: QQBindingInfo = {
  channel: "qq",
  sessionId: "session-1",
  appId: "102000001",
  appSecretMasked: "qq-a…1234",
  enabled: false,
  linePerMessage: false,
  // The other flag, set on a different fixture: neither can pass by riding the other.
  finalReplyOnly: true,
  renderMarkdown: true,
  lastChatKnown: true,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const STORED_WECHAT: WeChatBindingInfo = {
  channel: "wechat",
  sessionId: "session-1",
  botId: "bot_9001",
  botTokenMasked: "scan…-XYZ",
  enabled: false,
  linePerMessage: true,
  finalReplyOnly: false,
  renderMarkdown: false,
  lastChatKnown: true,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

const STORED_TUITUI: TuituiBindingInfo = {
  channel: "tuitui",
  sessionId: "session-1",
  appId: "tt_robot_1",
  appSecretMasked: "tt-r…-9999",
  // Not the platform's default host: a load that dropped the stored value would still look
  // right against a binding that happened to point at im.example.com.
  host: "im.internal.example.com",
  enabled: false,
  linePerMessage: true,
  finalReplyOnly: false,
  // The non-default value, for the same reason as the other fixtures': ON is the default, so
  // only a stored `false` proves the value was actually read.
  renderMarkdown: false,
  lastChatKnown: true,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

describe("emptyMessagingForm / bindingsToForm", () => {
  it("starts empty forms on Feishu with the default domain, both channels blank", () => {
    expect(emptyMessagingForm()).toEqual({
      channel: "feishu",
      // Markdown rendering starts ON, matching the server's default for a fresh binding.
      feishu: {
        appId: "",
        appSecret: "",
        baseDomain: FEISHU_DEFAULT_DOMAIN,
        clearSecret: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      telegram: {
        botToken: "",
        clearToken: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      qq: {
        appId: "",
        appSecret: "",
        clearSecret: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      // WeChat's sub-state is the preferences and the clear box: its token has no field.
      wechat: {
        clearToken: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      // Tuitui's host starts on the platform's own, like Feishu's domain.
      tuitui: {
        appId: "",
        appSecret: "",
        host: TUITUI_DEFAULT_HOST,
        clearSecret: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
    });
  });

  it("loads every saved config's non-secret fields, selects the enabled channel, and never loads a secret back", () => {
    // The masked value must not land in an editable field — an unedited save would
    // otherwise overwrite the real secret with its mask.
    const both = bindingsToForm([STORED_FEISHU, STORED_TELEGRAM]);
    expect(both).toEqual({
      channel: "telegram", // the enabled one wins the initial selection
      feishu: {
        appId: "cli_abc",
        appSecret: "",
        baseDomain: "https://open.larksuite.com",
        clearSecret: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      // Each channel's delivery preferences come from its own stored config — including the
      // one whose default is ON, which only a stored `false` can prove was actually read.
      telegram: {
        botToken: "",
        clearToken: false,
        linePerMessage: true,
        finalReplyOnly: false,
        renderMarkdown: false,
      },
      // An unsaved channel keeps its empty sub-state, so switching to it shows a blank form.
      qq: {
        appId: "",
        appSecret: "",
        clearSecret: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      wechat: {
        clearToken: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
      tuitui: {
        appId: "",
        appSecret: "",
        host: TUITUI_DEFAULT_HOST,
        clearSecret: false,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
    });
    // All of them coexist: every saved channel loads its own non-secret fields.
    const all = bindingsToForm([STORED_FEISHU, STORED_TELEGRAM, STORED_QQ, STORED_TUITUI]);
    expect(all.feishu.appId).toBe("cli_abc");
    expect(all.qq.appId).toBe("102000001");
    expect(all.qq.appSecret).toBe("");
    expect(all.tuitui.appId).toBe("tt_robot_1");
    expect(all.tuitui.host).toBe("im.internal.example.com");
    // Each flag loads from the channel that stored it, and from nowhere else.
    expect(all.qq.finalReplyOnly).toBe(true);
    expect(all.telegram.finalReplyOnly).toBe(false);
    expect(all.feishu.linePerMessage).toBe(false);
    expect(all.tuitui.linePerMessage).toBe(true);
    expect(all.feishu.renderMarkdown).toBe(true);
    // No enabled channel: the first saved one is selected; nothing saved: Feishu.
    expect(bindingsToForm([STORED_FEISHU]).channel).toBe("feishu");
    expect(bindingsToForm([STORED_QQ]).channel).toBe("qq");
    expect(bindingsToForm([STORED_TUITUI]).channel).toBe("tuitui");
    expect(bindingsToForm([]).channel).toBe("feishu");
  });
});

describe("formToPut (feishu)", () => {
  it("omits a blank secret so the server keeps the stored one", () => {
    const res = formToPut(bindingsToForm([STORED_FEISHU]), true);
    expect(res).toEqual({
      ok: true,
      channel: "feishu",
      body: {
        appId: "cli_abc",
        baseDomain: "https://open.larksuite.com",
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
    });
  });

  it("carries a typed secret, trimmed", () => {
    const form = bindingsToForm([STORED_FEISHU]);
    form.feishu.appSecret = "  new-secret  ";
    const res = formToPut(form, true);
    expect(res.ok && res.channel === "feishu" && res.body.appSecret).toBe("new-secret");
  });

  it("requires appId always, and a secret only on a first bind", () => {
    const blank = formToPut(emptyMessagingForm(), false);
    expect(blank).toEqual({ ok: false, errors: { appId: "required", appSecret: "required" } });
    // The same empty secret is fine once one is stored.
    const rebind = emptyMessagingForm();
    rebind.feishu.appId = "cli_x";
    expect(formToPut(rebind, true).ok).toBe(true);
  });

  it("maps the checked clear box to clearAppSecret, with a typed secret winning over it", () => {
    const clearing = bindingsToForm([STORED_FEISHU]);
    clearing.feishu.clearSecret = true;
    expect(formToPut(clearing, true)).toEqual({
      ok: true,
      channel: "feishu",
      body: {
        appId: "cli_abc",
        clearAppSecret: true,
        baseDomain: "https://open.larksuite.com",
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
    });
    // The models idiom: a typed replacement wins over a stale checked box.
    clearing.feishu.appSecret = "replacement-secret";
    const typed = formToPut(clearing, true);
    expect(typed.ok && typed.channel === "feishu" && typed.body).toEqual({
      appId: "cli_abc",
      appSecret: "replacement-secret",
      baseDomain: "https://open.larksuite.com",
      linePerMessage: false,
      finalReplyOnly: false,
      renderMarkdown: true,
    });
    // Without a stored secret there is nothing to clear: the flag never reaches the body.
    const nothingStored = emptyMessagingForm();
    nothingStored.feishu.appId = "cli_x";
    nothingStored.feishu.clearSecret = true;
    expect(formToPut(nothingStored, false)).toEqual({
      ok: false,
      errors: { appSecret: "required" },
    });
  });

  it("defaults a blank domain and rejects a non-http(s) one", () => {
    const form = emptyMessagingForm();
    form.feishu = {
      appId: "cli_x",
      appSecret: "s",
      baseDomain: "   ",
      clearSecret: false,
      linePerMessage: false,
      finalReplyOnly: false,
      renderMarkdown: true,
    };
    const blankDomain = formToPut(form, false);
    expect(blankDomain.ok && blankDomain.channel === "feishu" && blankDomain.body.baseDomain).toBe(
      FEISHU_DEFAULT_DOMAIN,
    );
    form.feishu.baseDomain = "open.feishu.cn";
    expect(formToPut(form, false)).toEqual({ ok: false, errors: { baseDomain: "url_invalid" } });
    form.feishu.baseDomain = "ftp://open.feishu.cn";
    expect(formToPut(form, false).ok).toBe(false);
  });
});

describe("formToPut (telegram)", () => {
  it("submits only the token, trimmed; blank keeps the stored one", () => {
    const form = emptyMessagingForm("telegram");
    form.telegram.botToken = "  7000000001:secret-token-AAAA  ";
    expect(formToPut(form, false)).toEqual({
      ok: true,
      channel: "telegram",
      body: {
        botToken: "7000000001:secret-token-AAAA",
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
    });
    // With a stored token an empty field means "keep it": the body omits the token — but not
    // the delivery flag, which is a plain field and always carries its current value.
    form.telegram.botToken = "";
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "telegram",
      body: { linePerMessage: false, finalReplyOnly: false, renderMarkdown: true },
    });
    // A first bind must carry one.
    expect(formToPut(form, false)).toEqual({ ok: false, errors: { botToken: "required" } });
  });

  it("maps the checked clear box to clearBotToken, with a typed token winning over it", () => {
    const form = emptyMessagingForm("telegram");
    form.telegram.clearToken = true;
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "telegram",
      body: {
        clearBotToken: true,
        linePerMessage: false,
        finalReplyOnly: false,
        renderMarkdown: true,
      },
    });
    form.telegram.botToken = "7000000001:replacement-token";
    const typed = formToPut(form, true);
    expect(typed.ok && typed.channel === "telegram" && typed.body).toEqual({
      botToken: "7000000001:replacement-token",
      linePerMessage: false,
      finalReplyOnly: false,
      renderMarkdown: true,
    });
  });

  it("rejects a token whose bot id cannot be read (the server's identity rule, mirrored)", () => {
    const form = emptyMessagingForm("telegram");
    form.telegram.botToken = "not-a-token";
    expect(formToPut(form, false)).toEqual({ ok: false, errors: { botToken: "token_invalid" } });
    form.telegram.botToken = "abc:def-ghi-jkl";
    expect(formToPut(form, true).ok).toBe(false);
  });

  it("never validates the unselected channel's fields", () => {
    // A blank Feishu form must not block a Telegram submit, and vice versa.
    const form = emptyMessagingForm("telegram");
    form.telegram.botToken = "7000000001:secret-token-AAAA";
    expect(formToPut(form, false).ok).toBe(true);
    const feishuSide = emptyMessagingForm("feishu");
    feishuSide.feishu = {
      appId: "cli_x",
      appSecret: "s",
      baseDomain: FEISHU_DEFAULT_DOMAIN,
      clearSecret: false,
      linePerMessage: false,
      finalReplyOnly: false,
      renderMarkdown: true,
    };
    feishuSide.telegram.botToken = "garbage";
    expect(formToPut(feishuSide, false).ok).toBe(true);
  });
});

describe("the delivery flags", () => {
  it("sends both on every channel, whatever their values, so either can be turned back off", () => {
    // The rule that makes them work at all: an omitted flag means "keep the stored value",
    // so a body that drops the ones currently off can never turn an option off again.
    for (const [form, channel] of [
      [emptyMessagingForm("feishu"), "feishu"],
      [emptyMessagingForm("telegram"), "telegram"],
      [emptyMessagingForm("qq"), "qq"],
      [emptyMessagingForm("tuitui"), "tuitui"],
    ] as const) {
      form.feishu.appId = "cli_x";
      form.qq.appId = "102000001";
      form.telegram.botToken = "7000000001:secret-token-AAAA";
      form.tuitui.appId = "tt_robot_1";
      for (const values of [
        { linePerMessage: false, finalReplyOnly: false },
        { linePerMessage: true, finalReplyOnly: false },
        { linePerMessage: false, finalReplyOnly: true },
        { linePerMessage: true, finalReplyOnly: true },
      ]) {
        Object.assign(form[channel], values);
        const res = formToPut(form, true);
        expect(res.ok).toBe(true);
        expect(res.ok && res.body.linePerMessage).toBe(values.linePerMessage);
        expect(res.ok && res.body.finalReplyOnly).toBe(values.finalReplyOnly);
      }
    }
  });
});

describe("formToTest", () => {
  it("carries only the selected channel's filled-in fields, so blanks fall back to the stored binding server-side", () => {
    // The fresh form prefills the default domain, and a prefilled value is a filled value.
    expect(formToTest(emptyMessagingForm())).toEqual({
      channel: "feishu",
      body: { baseDomain: FEISHU_DEFAULT_DOMAIN },
    });
    const blanked = emptyMessagingForm();
    blanked.feishu.baseDomain = "";
    expect(formToTest(blanked)).toEqual({ channel: "feishu", body: {} });
    const feishu = emptyMessagingForm();
    feishu.feishu = {
      appId: " cli_x ",
      appSecret: "s",
      baseDomain: FEISHU_DEFAULT_DOMAIN,
      clearSecret: false,
      linePerMessage: false,
      finalReplyOnly: false,
      renderMarkdown: true,
    };
    expect(formToTest(feishu)).toEqual({
      channel: "feishu",
      body: { appId: "cli_x", appSecret: "s", baseDomain: FEISHU_DEFAULT_DOMAIN },
    });
    const telegram = emptyMessagingForm("telegram");
    expect(formToTest(telegram)).toEqual({ channel: "telegram", body: {} });
    telegram.telegram.botToken = " 7000000001:tok-en-AAAA ";
    expect(formToTest(telegram)).toEqual({
      channel: "telegram",
      body: { botToken: "7000000001:tok-en-AAAA" },
    });
  });
});

describe("formDirty / formTestable", () => {
  it("marks the selected channel dirty on any field change; a typed secret and a checked clear box count", () => {
    const baseline = bindingsToForm([STORED_FEISHU]);
    expect(formDirty(bindingsToForm([STORED_FEISHU]), baseline)).toBe(false);
    const edited = bindingsToForm([STORED_FEISHU]);
    edited.feishu.appId = "cli_other";
    expect(formDirty(edited, baseline)).toBe(true);
    const secret = bindingsToForm([STORED_FEISHU]);
    secret.feishu.appSecret = "typed";
    expect(formDirty(secret, baseline)).toBe(true);
    const clearing = bindingsToForm([STORED_FEISHU]);
    clearing.feishu.clearSecret = true;
    expect(formDirty(clearing, baseline)).toBe(true);
    // Telegram: the token field always loads empty, so typed-token / checked-clear are the dirty signals.
    const tgBaseline = bindingsToForm([STORED_TELEGRAM]);
    const tg = bindingsToForm([STORED_TELEGRAM]);
    expect(formDirty(tg, tgBaseline)).toBe(false);
    tg.telegram.botToken = "7000000001:new";
    expect(formDirty(tg, tgBaseline)).toBe(true);
    tg.telegram.botToken = "";
    tg.telegram.clearToken = true;
    expect(formDirty(tg, tgBaseline)).toBe(true);
  });

  it("counts either delivery flag as an edit on every channel", () => {
    // Telegram is the one that would silently break: without these fields its only dirty
    // signals are the token and the clear box, so flipping a switch would leave Save disabled.
    const tgBaseline = bindingsToForm([STORED_TELEGRAM]);
    const tg = bindingsToForm([STORED_TELEGRAM]);
    tg.telegram.linePerMessage = !tg.telegram.linePerMessage;
    expect(formDirty(tg, tgBaseline)).toBe(true);
    const tgFinal = bindingsToForm([STORED_TELEGRAM]);
    tgFinal.telegram.finalReplyOnly = true;
    expect(formDirty(tgFinal, tgBaseline)).toBe(true);
    const baseline = bindingsToForm([STORED_FEISHU]);
    const feishu = bindingsToForm([STORED_FEISHU]);
    feishu.feishu.linePerMessage = true;
    expect(formDirty(feishu, baseline)).toBe(true);
    const feishuFinal = bindingsToForm([STORED_FEISHU]);
    feishuFinal.feishu.finalReplyOnly = true;
    expect(formDirty(feishuFinal, baseline)).toBe(true);
    // The unselected channel's flags are not the selected channel's business.
    const otherChannel = bindingsToForm([STORED_FEISHU]);
    otherChannel.telegram.linePerMessage = true;
    otherChannel.telegram.finalReplyOnly = true;
    expect(formDirty(otherChannel, baseline)).toBe(false);
  });

  it("allows the probe when the selected channel has a testable draft or a stored secret", () => {
    // Feishu drafts need both halves of the credential pair.
    expect(formTestable(emptyMessagingForm(), false)).toBe(false);
    const half = emptyMessagingForm();
    half.feishu.appId = "cli_x";
    expect(formTestable(half, false)).toBe(false);
    half.feishu.appSecret = "s";
    expect(formTestable(half, false)).toBe(true);
    // A stored secret makes the stored config testable without retyping anything.
    expect(formTestable(emptyMessagingForm(), true)).toBe(true);
    // Telegram: the token is the whole credential.
    expect(formTestable(emptyMessagingForm("telegram"), false)).toBe(false);
    expect(formTestable(emptyMessagingForm("telegram"), true)).toBe(true);
    const typed = emptyMessagingForm("telegram");
    typed.telegram.botToken = "7000000001:tok";
    expect(formTestable(typed, false)).toBe(true);
  });
});

describe("the QQ channel", () => {
  it("loads its non-secret field and leaves the secret empty, like the other channels", () => {
    const form = bindingsToForm([STORED_QQ]);
    // The selector lands on the only saved channel; the App ID loads, the secret never does.
    expect(form.channel).toBe("qq");
    expect(form.qq.appId).toBe("102000001");
    expect(form.qq.appSecret).toBe("");
    expect(form.qq.clearSecret).toBe(false);
    // Both delivery preferences load from the stored config, each on its own.
    expect(form.qq.finalReplyOnly).toBe(true);
    expect(form.qq.linePerMessage).toBe(false);
  });

  it("submits the pair, omits a blank secret, and always sends the delivery flag", () => {
    const form = bindingsToForm([STORED_QQ]);
    const kept = formToPut(form, true);
    expect(kept).toEqual({
      ok: true,
      channel: "qq",
      // No `appSecret` key at all: an omitted secret is what tells the server to keep the
      // stored one, and the masked value must never round-trip.
      body: {
        appId: "102000001",
        linePerMessage: false,
        finalReplyOnly: true,
        renderMarkdown: true,
      },
    });

    form.qq.appSecret = "  fresh-secret  ";
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "qq",
      body: {
        appId: "102000001",
        appSecret: "fresh-secret",
        linePerMessage: false,
        finalReplyOnly: true,
        renderMarkdown: true,
      },
    });
  });

  it("requires both halves on a first bind and honours the clear checkbox after one", () => {
    const fresh = emptyMessagingForm("qq");
    expect(formToPut(fresh, false)).toEqual({
      ok: false,
      errors: { appId: "required", appSecret: "required" },
    });

    const stored = bindingsToForm([STORED_QQ]);
    stored.qq.clearSecret = true;
    expect(formToPut(stored, true)).toEqual({
      ok: true,
      channel: "qq",
      body: {
        appId: "102000001",
        clearAppSecret: true,
        linePerMessage: false,
        finalReplyOnly: true,
        renderMarkdown: true,
      },
    });
    // A typed secret wins over a stale clear checkbox (the models idiom).
    stored.qq.appSecret = "typed";
    expect(formToPut(stored, true)).toEqual({
      ok: true,
      channel: "qq",
      body: {
        appId: "102000001",
        appSecret: "typed",
        linePerMessage: false,
        finalReplyOnly: true,
        renderMarkdown: true,
      },
    });
  });

  it("routes its probe and its dirty/testable checks to its own fields", () => {
    const form = bindingsToForm([STORED_QQ]);
    expect(formToTest(form)).toEqual({ channel: "qq", body: { appId: "102000001" } });

    const baseline = bindingsToForm([STORED_QQ]);
    expect(formDirty(form, baseline)).toBe(false);
    form.qq.linePerMessage = true;
    expect(formDirty(form, baseline)).toBe(true);
    const qqFinal = bindingsToForm([STORED_QQ]);
    qqFinal.qq.finalReplyOnly = !qqFinal.qq.finalReplyOnly;
    expect(formDirty(qqFinal, baseline)).toBe(true);

    // A stored secret is testable as-is; a draft needs both halves.
    expect(formTestable(emptyMessagingForm("qq"), true)).toBe(true);
    const half = emptyMessagingForm("qq");
    half.qq.appId = "102000001";
    expect(formTestable(half, false)).toBe(false);
    half.qq.appSecret = "s";
    expect(formTestable(half, false)).toBe(true);
  });
});

describe("the WeChat channel", () => {
  it("loads preferences and nothing else, having no credential field to load one into", () => {
    const form = bindingsToForm([STORED_WECHAT]);
    expect(form.channel).toBe("wechat");
    expect(form.wechat).toEqual({
      clearToken: false,
      linePerMessage: true,
      finalReplyOnly: false,
      renderMarkdown: false,
    });
  });

  it("submits preferences alone, and cannot fail validation because nothing is typed", () => {
    const form = bindingsToForm([STORED_WECHAT]);
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "wechat",
      // Always sent, like the other channels': an omitted flag means "keep", which would
      // leave no way to turn one back off.
      body: { linePerMessage: true, finalReplyOnly: false, renderMarkdown: false },
    });
  });

  it("sends the clear flag only when there is a stored token for it to drop", () => {
    const form = bindingsToForm([STORED_WECHAT]);
    form.wechat.clearToken = true;
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "wechat",
      body: {
        clearBotToken: true,
        linePerMessage: true,
        finalReplyOnly: false,
        renderMarkdown: false,
      },
    });
    // A checked box on a binding with nothing stored asks the server to drop nothing.
    expect(formToPut(form, false)).toEqual({
      ok: true,
      channel: "wechat",
      body: { linePerMessage: true, finalReplyOnly: false, renderMarkdown: false },
    });
  });

  it("routes its probe and its dirty/testable checks to its own fields", () => {
    const form = bindingsToForm([STORED_WECHAT]);
    // No body at all: the probe reads the stored binding, there being no draft to send.
    expect(formToTest(form)).toEqual({ channel: "wechat" });

    const baseline = bindingsToForm([STORED_WECHAT]);
    expect(formDirty(form, baseline)).toBe(false);
    form.wechat.renderMarkdown = !form.wechat.renderMarkdown;
    expect(formDirty(form, baseline)).toBe(true);
    const cleared = bindingsToForm([STORED_WECHAT]);
    cleared.wechat.clearToken = true;
    expect(formDirty(cleared, baseline)).toBe(true);

    // Only a stored token is testable: this channel has no draft credential, ever.
    expect(formTestable(emptyMessagingForm("wechat"), true)).toBe(true);
    expect(formTestable(emptyMessagingForm("wechat"), false)).toBe(false);
  });
});

describe("the Tuitui channel", () => {
  it("loads the App ID and the stored host, and leaves the secret empty", () => {
    const form = bindingsToForm([STORED_TUITUI]);
    // The selector lands on the only saved channel; both non-secret fields load, the secret never does.
    expect(form.channel).toBe("tuitui");
    expect(form.tuitui.appId).toBe("tt_robot_1");
    expect(form.tuitui.appSecret).toBe("");
    expect(form.tuitui.clearSecret).toBe(false);
    // The host is a stored value: a load that ignored it would fall back to the default and
    // only look right for a binding that happened to point at the platform's own host.
    expect(form.tuitui.host).toBe("im.internal.example.com");
    // Both delivery preferences load from the stored config, each on its own.
    expect(form.tuitui.linePerMessage).toBe(true);
    expect(form.tuitui.renderMarkdown).toBe(false);
  });

  it("submits the pair and the host, omitting a blank secret", () => {
    const form = bindingsToForm([STORED_TUITUI]);
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "tuitui",
      // No `appSecret` key at all: an omitted secret is what tells the server to keep the
      // stored one, and the masked value must never round-trip.
      body: {
        appId: "tt_robot_1",
        host: "im.internal.example.com",
        linePerMessage: true,
        finalReplyOnly: false,
        renderMarkdown: false,
      },
    });

    form.tuitui.appSecret = "  fresh-secret  ";
    expect(formToPut(form, true)).toEqual({
      ok: true,
      channel: "tuitui",
      body: {
        appId: "tt_robot_1",
        appSecret: "fresh-secret",
        host: "im.internal.example.com",
        linePerMessage: true,
        finalReplyOnly: false,
        renderMarkdown: false,
      },
    });
  });

  it("requires both halves on a first bind, and defaults a blank host", () => {
    expect(formToPut(emptyMessagingForm("tuitui"), false)).toEqual({
      ok: false,
      errors: { appId: "required", appSecret: "required" },
    });

    const form = emptyMessagingForm("tuitui");
    form.tuitui.appId = "tt_robot_1";
    form.tuitui.appSecret = "s";
    // A blank host is the "use the platform's own" gesture, like a blank Feishu domain.
    form.tuitui.host = "   ";
    const blank = formToPut(form, false);
    expect(blank.ok && blank.channel === "tuitui" && blank.body.host).toBe(TUITUI_DEFAULT_HOST);

    // The server takes a bare host name and nothing else: a scheme, a path and a port are
    // each refused rather than silently dropped by the URL this would be pasted into.
    for (const bad of [
      "https://im.example.com/robot",
      "im.example.com/robot",
      "im.example.com:8282",
    ]) {
      form.tuitui.host = bad;
      expect(formToPut(form, false)).toEqual({ ok: false, errors: { host: "host_invalid" } });
    }
    form.tuitui.host = "im.example.com";
    expect(formToPut(form, false).ok).toBe(true);
  });

  it("honours the clear checkbox after a bind, with a typed secret winning over it", () => {
    const stored = bindingsToForm([STORED_TUITUI]);
    stored.tuitui.clearSecret = true;
    expect(formToPut(stored, true)).toEqual({
      ok: true,
      channel: "tuitui",
      body: {
        appId: "tt_robot_1",
        clearAppSecret: true,
        host: "im.internal.example.com",
        linePerMessage: true,
        finalReplyOnly: false,
        renderMarkdown: false,
      },
    });
    // A typed secret wins over a stale clear checkbox (the models idiom).
    stored.tuitui.appSecret = "typed";
    expect(formToPut(stored, true)).toEqual({
      ok: true,
      channel: "tuitui",
      body: {
        appId: "tt_robot_1",
        appSecret: "typed",
        host: "im.internal.example.com",
        linePerMessage: true,
        finalReplyOnly: false,
        renderMarkdown: false,
      },
    });
  });

  it("routes its probe and its dirty/testable checks to its own fields", () => {
    const form = bindingsToForm([STORED_TUITUI]);
    // The filled-in fields only: a blank one falls back to the stored binding server-side.
    expect(formToTest(form)).toEqual({
      channel: "tuitui",
      body: { appId: "tt_robot_1", host: "im.internal.example.com" },
    });
    const blanked = bindingsToForm([STORED_TUITUI]);
    blanked.tuitui.host = "";
    expect(formToTest(blanked)).toEqual({ channel: "tuitui", body: { appId: "tt_robot_1" } });
    // No untrimmed draft: the host is sent as the server would store it.
    const padded = bindingsToForm([STORED_TUITUI]);
    padded.tuitui.host = "  im.internal.example.com  ";
    const paddedTest = formToTest(padded);
    expect(paddedTest.channel === "tuitui" && paddedTest.body).toEqual({
      appId: "tt_robot_1",
      host: "im.internal.example.com",
    });

    const baseline = bindingsToForm([STORED_TUITUI]);
    expect(formDirty(form, baseline)).toBe(false);
    form.tuitui.host = TUITUI_DEFAULT_HOST;
    expect(formDirty(form, baseline)).toBe(true);
    const typed = bindingsToForm([STORED_TUITUI]);
    typed.tuitui.appSecret = "typed";
    expect(formDirty(typed, baseline)).toBe(true);
    const clearing = bindingsToForm([STORED_TUITUI]);
    clearing.tuitui.clearSecret = true;
    expect(formDirty(clearing, baseline)).toBe(true);
    // ...and the unselected channels' edits are not this channel's business.
    const other = bindingsToForm([STORED_TUITUI]);
    other.feishu.appId = "cli_other";
    other.telegram.botToken = "7000000001:tok";
    expect(formDirty(other, baseline)).toBe(false);

    // A stored secret is testable as-is; a draft needs both halves, like the other pair channels.
    expect(formTestable(emptyMessagingForm("tuitui"), true)).toBe(true);
    const half = emptyMessagingForm("tuitui");
    half.tuitui.appId = "tt_robot_1";
    expect(formTestable(half, false)).toBe(false);
    half.tuitui.appSecret = "s";
    expect(formTestable(half, false)).toBe(true);
  });
});
