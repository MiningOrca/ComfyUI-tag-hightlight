const WEIGHT_SUFFIX_RE = /:\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/;
const OUTER_PARENS_RE = /^\((.*)\)$/s;
const OUTER_BRACKETS_RE = /^\[(.*)\]$/s;

export function normalizeTag(raw) {
    let value = String(raw ?? "").trim();

    if (!value) return "";

    if (/^<lora:[^>]+>$/i.test(value)) {
        return value.toLowerCase();
    }

    if (/^embedding:/i.test(value)) {
        return value.toLowerCase();
    }

    if (/^__[^_].*__$/s.test(value)) {
        return value.toLowerCase();
    }

    // Remove simple attention wrappers while preserving the actual tag.
    // We intentionally do not implement arbitrary prompt-language parsing.
    for (let i = 0; i < 4; i += 1) {
        const paren = value.match(OUTER_PARENS_RE);
        const bracket = value.match(OUTER_BRACKETS_RE);

        if (paren) {
            value = paren[1].trim();
            continue;
        }
        if (bracket) {
            value = bracket[1].trim();
            continue;
        }
        break;
    }

    value = value.replace(WEIGHT_SUFFIX_RE, "").trim();

    // Common booru spelling -> natural text for the embedding model.
    value = value
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    return value;
}

export function syntaxCategory(coreText) {
    const value = String(coreText ?? "").trim();

    if (/^<lora:[^>]+>$/i.test(value)) return "lora";
    if (/^embedding:/i.test(value)) return "embedding";
    if (/^__[^_].*__$/s.test(value)) return "wildcard";

    return null;
}

export function parsePrompt(text) {
    const source = String(text ?? "");
    const segments = [];

    let start = 0;

    const pushSegment = (end, comma = "") => {
        const raw = source.slice(start, end);

        const leadingMatch = raw.match(/^\s*/);
        const trailingMatch = raw.match(/\s*$/);

        const leading = leadingMatch?.[0] ?? "";
        const trailing = trailingMatch?.[0] ?? "";

        const coreStart = leading.length;
        const coreEnd = Math.max(coreStart, raw.length - trailing.length);
        const core = raw.slice(coreStart, coreEnd);

        const normalized = normalizeTag(core);

        segments.push({
            raw,
            leading,
            core,
            trailing,
            comma,
            normalized,
            syntaxCategory: syntaxCategory(core),
        });
    };

    for (let i = 0; i < source.length; i += 1) {
        if (source[i] !== ",") continue;
        pushSegment(i, ",");
        start = i + 1;
    }

    pushSegment(source.length, "");

    return segments;
}

export function categoryForRecord(record, minScore, minMargin) {
    if (!record) return "other";

    if (
        Number(record.score) >= Number(minScore) &&
        Number(record.margin) >= Number(minMargin)
    ) {
        return record.category;
    }

    return "other";
}
