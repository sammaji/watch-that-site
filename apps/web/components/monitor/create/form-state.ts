import type { Monitor, MonitorInput } from "@/hooks/use-monitors";
import { SECRET_NAME } from "@/lib/macro";
import type { ProviderConnection, Urgency } from "@watchthatsite/types";

/**
 * The Monitor form's state and its mapping to and from a `monitors` row.
 * The Macro goal and the secrets are not Monitor columns: the form hands them
 * to the server after the Monitor is saved.
 */

export type ViewportPreset = {
    value: string;
    label: string;
    width: number;
    height: number;
};

export const VIEWPORTS: ViewportPreset[] = [
    {
        value: "desktop",
        label: "Desktop (1366 × 768)",
        width: 1366,
        height: 768,
    },
    { value: "laptop", label: "Laptop (1280 × 720)", width: 1280, height: 720 },
    { value: "tablet", label: "Tablet (768 × 1024)", width: 768, height: 1024 },
    { value: "mobile", label: "Mobile (390 × 844)", width: 390, height: 844 },
];

export const INTERVALS = [
    { value: "5", label: "Every 5 minutes" },
    { value: "15", label: "Every 15 minutes" },
    { value: "30", label: "Every 30 minutes" },
    { value: "60", label: "Every hour" },
    { value: "360", label: "Every 6 hours" },
    { value: "1440", label: "Every day" },
    { value: "10080", label: "Every week" },
    { value: "43200", label: "Every 30 days" },
];

/** The Select value for "no schedule". */
export const MANUAL_INTERVAL = "manual";

export const URGENCIES: { value: Urgency; label: string; hint: string }[] = [
    {
        value: "instant",
        label: "Right away",
        hint: "One notification per Change, as soon as it is found.",
    },
    {
        value: "hourly",
        label: "In an hourly digest",
        hint: "Changes are collected and sent together once an hour.",
    },
    {
        value: "daily",
        label: "In a daily digest",
        hint: "Changes are collected and sent together once a day.",
    },
];

/** Starting points for the Instructions; a click fills the field. */
export type SecretDraft = { key: string; name: string; value: string };

export type FormState = {
    name: string;
    url: string;
    instructions: string;
    /** Minutes as a string, or MANUAL_INTERVAL. */
    interval: string;

    /** What the Macro should do before each check; "" for no Macro. */
    goal: string;
    secrets: SecretDraft[];

    connectionId: string | null;
    model: string | null;
    confirmChanges: boolean;
    urgency: Urgency;
    viewport: string;
    /** Kept when the Monitor has a size none of the presets match. */
    customViewport: { width: number; height: number } | null;
    blockAds: boolean;
};

export type FormErrors = Partial<Record<"name" | "url" | "secrets", string>>;

let secretKey = 0;
export function newSecret(): SecretDraft {
    return { key: `s${++secretKey}`, name: "", value: "" };
}

export function emptyForm(): FormState {
    return {
        name: "",
        url: "",
        instructions: "",
        interval: "60",
        goal: "",
        secrets: [],
        connectionId: null,
        model: null,
        confirmChanges: false,
        urgency: "instant",
        viewport: "desktop",
        customViewport: null,
        blockAds: true,
    };
}

export function fromMonitor(monitor: Monitor): FormState {
    const preset = VIEWPORTS.find(
        v => v.width === monitor.viewport_w && v.height === monitor.viewport_h,
    );
    return {
        ...emptyForm(),
        name: monitor.name,
        url: monitor.url,
        instructions: monitor.instructions ?? "",
        interval:
            monitor.interval_minutes == null ?
                MANUAL_INTERVAL
            :   String(monitor.interval_minutes),
        connectionId: monitor.connection_id,
        model: monitor.model,
        confirmChanges: monitor.confirm_changes,
        urgency: monitor.urgency,
        viewport: preset?.value ?? "custom",
        customViewport:
            preset ? null : (
                { width: monitor.viewport_w, height: monitor.viewport_h }
            ),
        blockAds: monitor.block_ads,
    };
}

export function viewportSize(form: FormState): {
    width: number;
    height: number;
} {
    if (form.viewport === "custom" && form.customViewport) {
        return form.customViewport;
    }
    return VIEWPORTS.find(v => v.value === form.viewport) ?? VIEWPORTS[0]!;
}

export function isHttpUrl(value: string): boolean {
    try {
        return /^https?:$/.test(new URL(value).protocol);
    } catch {
        return false;
    }
}

/** A name for a Monitor whose page gave no title: "example.com/pricing". */
export function nameFromUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/\/+$/, "");
        return `${parsed.host.replace(/^www\./, "")}${path}`;
    } catch {
        return url;
    }
}

/** The secrets the owner actually filled in. */
export function filledSecrets(form: FormState): SecretDraft[] {
    return form.secrets.filter(s => s.name.trim() !== "" || s.value !== "");
}

export function validate(form: FormState): FormErrors {
    const errors: FormErrors = {};
    const url = form.url.trim();
    if (url === "") {
        errors.url = "Enter the address of the page to watch.";
    } else if (!isHttpUrl(url)) {
        errors.url = "Enter a full address, starting with https:// or http://.";
    }
    const secrets = filledSecrets(form);
    const names = new Set<string>();
    for (const secret of secrets) {
        const name = secret.name.trim();
        if (!SECRET_NAME.test(name)) {
            errors.secrets =
                "Name each secret with lowercase letters, digits and underscores, starting with a letter, for example “password”.";
            break;
        }
        if (secret.value === "") {
            errors.secrets = `Enter a value for “${name}”, or remove it.`;
            break;
        }
        if (names.has(name)) {
            errors.secrets = `Two secrets are named “${name}”. Give each its own name.`;
            break;
        }
        names.add(name);
    }
    return errors;
}

export function toMonitorInput(form: FormState): MonitorInput {
    const url = form.url.trim();
    const size = viewportSize(form);
    const model = form.model?.trim() || null;
    return {
        name: form.name.trim() || nameFromUrl(url),
        url,
        interval_minutes:
            form.interval === MANUAL_INTERVAL ? null : Number(form.interval),
        instructions: form.instructions.trim(),
        // A model without its connection (or the reverse) is no use to the
        // agent: keep them together or leave both empty.
        connection_id: form.connectionId && model ? form.connectionId : null,
        model: form.connectionId && model ? model : null,
        confirm_changes: form.confirmChanges,
        urgency: form.urgency,
        block_ads: form.blockAds,
        viewport_w: size.width,
        viewport_h: size.height,
    };
}

/** The connection and model a new Monitor starts with. */
export function defaultModel(
    connections: ProviderConnection[] | undefined,
): { connectionId: string; model: string | null } | null {
    const first = (connections ?? []).find(c => c.enabled);
    if (!first) return null;
    return {
        connectionId: first.id,
        model: first.default_model ?? first.models[0] ?? null,
    };
}
