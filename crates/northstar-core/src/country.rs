//! Conservative country detection for server labels.
//!
//! Signals: a leading flag emoji, or an exact/prefix country-name match after
//! removing the flag and trailing server number. No IP geolocation is done, and
//! unknown labels stay unknown.

use serde::Serialize;

/// ISO 3166-1 alpha-2 codes with their canonical English names.
const COUNTRIES: &[(&str, &str)] = &[
    ("AF", "Afghanistan"),
    ("AL", "Albania"),
    ("DZ", "Algeria"),
    ("AR", "Argentina"),
    ("AM", "Armenia"),
    ("AU", "Australia"),
    ("AT", "Austria"),
    ("AZ", "Azerbaijan"),
    ("BH", "Bahrain"),
    ("BD", "Bangladesh"),
    ("BY", "Belarus"),
    ("BE", "Belgium"),
    ("BZ", "Belize"),
    ("BO", "Bolivia"),
    ("BR", "Brazil"),
    ("BG", "Bulgaria"),
    ("KH", "Cambodia"),
    ("CM", "Cameroon"),
    ("CA", "Canada"),
    ("CL", "Chile"),
    ("CN", "China"),
    ("CO", "Colombia"),
    ("CR", "Costa Rica"),
    ("HR", "Croatia"),
    ("CY", "Cyprus"),
    ("CZ", "Czechia"),
    ("DK", "Denmark"),
    ("DO", "Dominican Republic"),
    ("EC", "Ecuador"),
    ("EG", "Egypt"),
    ("EE", "Estonia"),
    ("FI", "Finland"),
    ("FR", "France"),
    ("GE", "Georgia"),
    ("DE", "Germany"),
    ("GH", "Ghana"),
    ("GR", "Greece"),
    ("GT", "Guatemala"),
    ("HK", "Hong Kong"),
    ("HU", "Hungary"),
    ("IS", "Iceland"),
    ("IN", "India"),
    ("ID", "Indonesia"),
    ("IR", "Iran"),
    ("IE", "Ireland"),
    ("IL", "Israel"),
    ("IT", "Italy"),
    ("JM", "Jamaica"),
    ("JP", "Japan"),
    ("JO", "Jordan"),
    ("KZ", "Kazakhstan"),
    ("KE", "Kenya"),
    ("KR", "South Korea"),
    ("KW", "Kuwait"),
    ("LV", "Latvia"),
    ("LB", "Lebanon"),
    ("LT", "Lithuania"),
    ("LU", "Luxembourg"),
    ("MO", "Macao"),
    ("MY", "Malaysia"),
    ("MT", "Malta"),
    ("MX", "Mexico"),
    ("MD", "Moldova"),
    ("MN", "Mongolia"),
    ("ME", "Montenegro"),
    ("MA", "Morocco"),
    ("MM", "Myanmar"),
    ("NP", "Nepal"),
    ("NL", "Netherlands"),
    ("NZ", "New Zealand"),
    ("NG", "Nigeria"),
    ("MK", "North Macedonia"),
    ("NO", "Norway"),
    ("OM", "Oman"),
    ("PK", "Pakistan"),
    ("PA", "Panama"),
    ("PE", "Peru"),
    ("PH", "Philippines"),
    ("PL", "Poland"),
    ("PT", "Portugal"),
    ("PR", "Puerto Rico"),
    ("QA", "Qatar"),
    ("RO", "Romania"),
    ("RU", "Russia"),
    ("SA", "Saudi Arabia"),
    ("RS", "Serbia"),
    ("SG", "Singapore"),
    ("SK", "Slovakia"),
    ("SI", "Slovenia"),
    ("ZA", "South Africa"),
    ("ES", "Spain"),
    ("LK", "Sri Lanka"),
    ("SE", "Sweden"),
    ("CH", "Switzerland"),
    ("SY", "Syria"),
    ("TW", "Taiwan"),
    ("TH", "Thailand"),
    ("TN", "Tunisia"),
    ("TR", "Turkey"),
    ("UA", "Ukraine"),
    ("AE", "United Arab Emirates"),
    ("GB", "United Kingdom"),
    ("US", "United States"),
    ("UY", "Uruguay"),
    ("UZ", "Uzbekistan"),
    ("VE", "Venezuela"),
    ("VN", "Vietnam"),
    ("YE", "Yemen"),
    ("ZM", "Zambia"),
    ("ZW", "Zimbabwe"),
];

/// Spellings that resolve to a code, already normalised (lowercase, no "the").
const ALIASES: &[(&str, &str)] = &[
    ("united states of america", "US"),
    ("usa", "US"),
    ("us", "US"),
    ("america", "US"),
    ("u s", "US"),
    ("uk", "GB"),
    ("great britain", "GB"),
    ("britain", "GB"),
    ("england", "GB"),
    ("netherlands", "NL"),
    ("holland", "NL"),
    ("russian federation", "RU"),
    ("republic of korea", "KR"),
    ("korea", "KR"),
    ("s korea", "KR"),
    ("hongkong", "HK"),
    ("h k", "HK"),
    ("republic of china", "TW"),
    ("czech republic", "CZ"),
    ("uae", "AE"),
    ("emirates", "AE"),
    ("turkiye", "TR"),
    ("türkiye", "TR"),
    ("ir", "IR"),
    ("viet nam", "VN"),
    ("myanmar burma", "MM"),
    ("bosnia and herzegovina", "BA"),
    ("north macedonia", "MK"),
    ("macedonia", "MK"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Country {
    pub code: String,
    pub name: String,
    pub flag: String,
}

pub fn country_name(code: &str) -> Option<&'static str> {
    COUNTRIES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, name)| *name)
}

/// Human-facing name; the Netherlands reads better with its article.
pub fn display_name(code: &str) -> Option<&'static str> {
    match code {
        "NL" => Some("The Netherlands"),
        other => country_name(other),
    }
}

/// Builds the regional-indicator flag emoji for a known ISO code.
pub fn flag_for(code: &str) -> String {
    if code.len() != 2 || country_name(code).is_none() {
        return String::new();
    }
    let mut out = String::new();
    for ch in code.chars() {
        let upper = ch.to_ascii_uppercase() as u32;
        if !(b'A' as u32..=b'Z' as u32).contains(&upper) {
            return String::new();
        }
        let point = 0x1F1E6 + (upper - b'A' as u32);
        match char::from_u32(point) {
            Some(c) => out.push(c),
            None => return String::new(),
        }
    }
    out
}

fn is_regional_indicator(c: char) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&(c as u32))
}

/// Reads a leading flag emoji and returns the ISO code when it is known.
pub fn code_from_flag(label: &str) -> Option<String> {
    let mut chars = label.chars();
    let a = chars.next()?;
    let b = chars.next()?;
    if !is_regional_indicator(a) || !is_regional_indicator(b) {
        return None;
    }
    let letter = |c: char| char::from_u32(b'A' as u32 + (c as u32 - 0x1F1E6)).unwrap_or('?');
    let code = format!("{}{}", letter(a), letter(b));
    if country_name(&code).is_some() {
        Some(code)
    } else {
        None
    }
}

/// Removes flag emoji and leading decorative separators from a label.
pub fn strip_flag(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut iter = label.chars().peekable();
    while let Some(c) = iter.next() {
        if is_regional_indicator(c) {
            if let Some(&next) = iter.peek() {
                if is_regional_indicator(next) {
                    iter.next();
                }
            }
            continue;
        }
        out.push(c);
    }
    out.trim_start_matches(|c: char| c.is_whitespace() || "-–—•|/\\".contains(c))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_key(name: &str) -> String {
    let lower = name.to_lowercase().replace(['.', ','], " ");
    let collapsed = lower.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .strip_prefix("the ")
        .unwrap_or(&collapsed)
        .trim()
        .to_string()
}

/// The trailing server number is not part of the country name.
fn without_trailing_number(name: &str) -> &str {
    let trimmed = name.trim_end();
    let mut digit_start = trimmed.len();
    for (index, ch) in trimmed.char_indices().rev() {
        if ch.is_ascii_digit() {
            digit_start = index;
        } else {
            break;
        }
    }
    if digit_start == trimmed.len() {
        return trimmed;
    }
    let head = &trimmed[..digit_start];
    head.trim_end_matches(|c: char| c.is_whitespace() || "._|-".contains(c))
}

/// Detects a country from a server label, or returns `None` when unsure.
pub fn detect_country(raw: &str) -> Option<Country> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(code) = code_from_flag(trimmed) {
        return Some(Country {
            name: display_name(&code)?.to_string(),
            flag: flag_for(&code),
            code,
        });
    }

    let decorated = strip_flag(trimmed);
    let base = without_trailing_number(&decorated);
    let key = normalize_key(base);
    if key.is_empty() {
        return None;
    }

    let direct = COUNTRIES
        .iter()
        .find(|(_, name)| normalize_key(name) == key)
        .map(|(code, _)| *code)
        .or_else(|| {
            ALIASES
                .iter()
                .find(|(alias, _)| *alias == key)
                .map(|(_, code)| *code)
        });

    let code = direct.or_else(|| {
        ALIASES
            .iter()
            .find(|(alias, _)| key.starts_with(&format!("{alias} ")))
            .map(|(_, code)| *code)
            .or_else(|| {
                COUNTRIES
                    .iter()
                    .find(|(_, name)| key.starts_with(&format!("{} ", normalize_key(name))))
                    .map(|(code, _)| *code)
            })
    })?;

    Some(Country {
        name: display_name(code)?.to_string(),
        flag: flag_for(code),
        code: code.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_flags_and_names() {
        let nl = detect_country("🇳🇱 The Netherlands 272").unwrap();
        assert_eq!(nl.code, "NL");
        assert_eq!(nl.name, "The Netherlands");
        assert_eq!(nl.flag, "🇳🇱");
        assert_eq!(flag_for("US"), "🇺🇸");
        assert_eq!(flag_for("ZZ"), "");
    }

    #[test]
    fn resolves_aliases_and_prefixes() {
        assert_eq!(detect_country("Holland 03").unwrap().code, "NL");
        assert_eq!(detect_country("The Netherlands 005").unwrap().code, "NL");
        assert_eq!(detect_country("USA 12").unwrap().code, "US");
        assert_eq!(detect_country("Germany FRA-01").unwrap().code, "DE");
        assert_eq!(detect_country("Türkiye 01").unwrap().code, "TR");
    }

    #[test]
    fn unknowns_stay_unknown() {
        assert!(detect_country("MysteryNode 12").is_none());
        assert!(detect_country("srv-01.example.net").is_none());
        assert!(detect_country("").is_none());
        assert!(detect_country("42").is_none());
        assert!(detect_country("🔥 hot server").is_none());
    }
}
