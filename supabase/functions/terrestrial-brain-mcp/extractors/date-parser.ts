/**
 * Date extraction from checkbox text.
 *
 * Parses common date patterns (ISO, natural, relative) and strips matched
 * fragments from content. Includes LLM batch fallback for ambiguous cases.
 */

const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE") || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

// ---------------------------------------------------------------------------
// Month / day lookup tables
// ---------------------------------------------------------------------------

const MONTH_FULL: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const MONTH_SHORT: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const DAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DateExtractionResult {
  cleanedText: string;
  dueDate: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthNameToNumber(name: string): number | null {
  const lower = name.toLowerCase();
  return MONTH_FULL[lower] ?? MONTH_SHORT[lower] ?? null;
}

function buildISODate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month, day));
  if (isNaN(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

function inferYear(month: number, day: number, referenceDate: Date): number {
  const currentYear = referenceDate.getUTCFullYear();
  const currentMonth = referenceDate.getUTCMonth();
  const currentDay = referenceDate.getUTCDate();

  if (month < currentMonth || (month === currentMonth && day < currentDay)) {
    return currentYear + 1;
  }
  return currentYear;
}

function resolveNextDayOfWeek(dayName: string, referenceDate: Date): string | null {
  const targetDay = DAY_INDEX[dayName.toLowerCase()];
  if (targetDay === undefined) return null;

  const currentDay = referenceDate.getUTCDay();
  let daysAhead = targetDay - currentDay;
  if (daysAhead <= 0) daysAhead += 7;

  const result = new Date(referenceDate);
  result.setUTCDate(result.getUTCDate() + daysAhead);
  return buildISODate(
    result.getUTCFullYear(),
    result.getUTCMonth(),
    result.getUTCDate(),
  );
}

const ORDINAL_SUFFIX = /(?:st|nd|rd|th)/i;

function stripOrdinal(dayStr: string): number {
  return parseInt(dayStr.replace(ORDINAL_SUFFIX, ""), 10);
}

function parseNaturalDate(fragment: string, referenceDate: Date): string | null {
  // "Month Day(, Year)" — e.g. "March 30", "March 30th", "March 30, 2026"
  const monthFirst = fragment.match(/([A-Za-z]+)\s+(\d{1,2}(?:st|nd|rd|th)?)(?:,?\s+(\d{4}))?/i);
  if (monthFirst) {
    const month = monthNameToNumber(monthFirst[1]);
    if (month !== null) {
      const day = stripOrdinal(monthFirst[2]);
      const year = monthFirst[3]
        ? parseInt(monthFirst[3], 10)
        : inferYear(month, day, referenceDate);
      return buildISODate(year, month, day);
    }
  }

  // "Day Month(, Year)" — e.g. "30 March", "30th March 2026"
  const dayFirst = fragment.match(/(\d{1,2}(?:st|nd|rd|th)?)\s+([A-Za-z]+)(?:,?\s+(\d{4}))?/i);
  if (dayFirst) {
    const month = monthNameToNumber(dayFirst[2]);
    if (month !== null) {
      const day = stripOrdinal(dayFirst[1]);
      const year = dayFirst[3]
        ? parseInt(dayFirst[3], 10)
        : inferYear(month, day, referenceDate);
      return buildISODate(year, month, day);
    }
  }

  return null;
}

/**
 * Cleans up text after stripping date/assignment fragments.
 * Removes empty parens, dangling commas, and collapses whitespace.
 */
export function cleanStrippedText(text: string): string {
  return text
    .replace(/\(\s*\)/g, "")
    .replace(/,\s*$/, "")
    .replace(/^\s*,/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Build regex patterns (dynamic from month/day names)
// ---------------------------------------------------------------------------

const allMonthNames = [...Object.keys(MONTH_FULL), ...Object.keys(MONTH_SHORT)];
const allDayNames = Object.keys(DAY_INDEX);
const monthPattern = allMonthNames.join("|");
const dayNamePattern = allDayNames.join("|");
const markerPattern = "(?:due|by|deadline|before)";
// Ordinal day: "5th", "1st", "2nd", "23rd"
const dayNumber = "\\d{1,2}(?:st|nd|rd|th)?";

interface DatePattern {
  regex: RegExp;
  parse: (match: RegExpMatchArray, referenceDate: Date) => string | null;
}

const DATE_PATTERNS: DatePattern[] = [
  // 1. Marker + ISO date: "(deadline: 2026-04-01)" or "by 2026-04-01"
  {
    regex: new RegExp(
      `\\(?\\s*${markerPattern}\\s*:?\\s*(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})\\s*\\)?`,
      "i",
    ),
    parse: (match) => {
      const normalized = match[1].replace(/\//g, "-");
      const parts = normalized.split("-").map(Number);
      return buildISODate(parts[0], parts[1] - 1, parts[2]);
    },
  },
  // 2. Bare ISO date: "2026-04-01"
  {
    regex: /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
    parse: (match) => {
      const normalized = match[1].replace(/\//g, "-");
      const parts = normalized.split("-").map(Number);
      return buildISODate(parts[0], parts[1] - 1, parts[2]);
    },
  },
  // 3. Marker + "Month Day(, Year)": "(deadline: August 5th)" or "due March 30"
  {
    regex: new RegExp(
      `\\(?\\s*${markerPattern}\\s*:?\\s*((?:${monthPattern})\\s+${dayNumber}(?:,?\\s+\\d{4})?)\\s*\\)?`,
      "i",
    ),
    parse: (match, ref) => parseNaturalDate(match[1], ref),
  },
  // 4. Marker + "Day Month(, Year)": "(deadline: 5th August)" or "due 30 March"
  {
    regex: new RegExp(
      `\\(?\\s*${markerPattern}\\s*:?\\s*(${dayNumber}\\s+(?:${monthPattern})(?:,?\\s+\\d{4})?)\\s*\\)?`,
      "i",
    ),
    parse: (match, ref) => parseNaturalDate(match[1], ref),
  },
  // 5. Marker + "tomorrow": "(by tomorrow)" or "by tomorrow"
  {
    regex: new RegExp(`\\(?\\s*${markerPattern}\\s*:?\\s*(tomorrow)\\s*\\)?`, "i"),
    parse: (_match, ref) => {
      const tomorrow = new Date(ref);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      return buildISODate(
        tomorrow.getUTCFullYear(),
        tomorrow.getUTCMonth(),
        tomorrow.getUTCDate(),
      );
    },
  },
  // 6. Marker + day name: "(by Friday)", "due next Monday"
  {
    regex: new RegExp(
      `\\(?\\s*${markerPattern}\\s*:?\\s*(?:next\\s+)?(${dayNamePattern})\\s*\\)?`,
      "i",
    ),
    parse: (match, ref) => resolveNextDayOfWeek(match[1], ref),
  },
];

// ---------------------------------------------------------------------------
// Main export: regex-based date extraction
// ---------------------------------------------------------------------------

export function extractDueDate(
  text: string,
  referenceDate: Date = new Date(),
): DateExtractionResult {
  for (const { regex, parse } of DATE_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      const dueDate = parse(match, referenceDate);
      if (dueDate) {
        const cleanedText = cleanStrippedText(text.replace(match[0], ""));
        return { cleanedText, dueDate };
      }
    }
  }
  return { cleanedText: text, dueDate: null };
}

// ---------------------------------------------------------------------------
// Heuristic: does text contain date-like words?
// ---------------------------------------------------------------------------

const DATE_LIKE_WORDS = new RegExp(
  `\\b(${monthPattern}|${dayNamePattern}|tomorrow|deadline|due date|next week|end of (?:week|month|quarter))\\b`,
  "i",
);

export function containsDateLikeWords(text: string): boolean {
  return DATE_LIKE_WORDS.test(text);
}

// ---------------------------------------------------------------------------
// LLM batch fallback for ambiguous dates
// ---------------------------------------------------------------------------

export interface LLMDateResult {
  taskIndex: number;
  dueDate: string;
  cleanedText: string;
}

export async function inferDatesFromContent(
  texts: { index: number; text: string }[],
  referenceDate: Date = new Date(),
): Promise<LLMDateResult[]> {
  if (texts.length === 0) return [];

  const taskList = texts
    .map((task) => `${task.index}: "${task.text}"`)
    .join("\n");

  const referenceDateStr = referenceDate.toISOString().split("T")[0];

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You extract due dates from task descriptions. Today's date is ${referenceDateStr}. For each task that contains a date or deadline reference, return the resolved ISO date and the task text with the date fragment removed. If a task has no date, omit it.

Return JSON: {"dates": [{"task_index": 0, "due_date": "2026-04-01T00:00:00.000Z", "cleaned_text": "task without date part"}, ...]}`,
          },
          {
            role: "user",
            content: `TASKS:\n${taskList}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`Date inference LLM call failed: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    if (!Array.isArray(parsed.dates)) return [];

    return parsed.dates
      .filter(
        (entry: { task_index?: unknown; due_date?: unknown; cleaned_text?: unknown }) =>
          typeof entry.task_index === "number" &&
          typeof entry.due_date === "string" &&
          typeof entry.cleaned_text === "string" &&
          !isNaN(new Date(entry.due_date).getTime()),
      )
      .map((entry: { task_index: number; due_date: string; cleaned_text: string }) => ({
        taskIndex: entry.task_index,
        dueDate: new Date(entry.due_date).toISOString(),
        cleanedText: entry.cleaned_text,
      }));
  } catch (error) {
    console.error(`Date inference LLM error: ${(error as Error).message}`);
    return [];
  }
}
