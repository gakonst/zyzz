//! Converts absolute sRGB colors without consulting platform or inherited state.

use crate::generated::literal::NAMED_COLORS;
use crate::js;
use crate::react_native::internal::scalar::{Decimal, Exponent, Fraction};

/// Normalizes functional colors to byte-accurate RGBA hex for native parsers.
///
/// `color-mix(in srgb, color N%, transparent)` converts when `color` is a hex or functional
/// color. Returns `None` for inherited, relative, wide-gamut, and malformed colors.
pub fn parse(input: &str) -> Option<String> {
    // Every accepted spelling is ASCII, so ASCII folding decides acceptance like `toLowerCase`.
    let value = js::trim(input).to_ascii_lowercase();

    if value == "transparent" || hex(&value) || NAMED_COLORS.contains(&value.as_str()) {
        return Some(value);
    }

    if let Some((color, opacity)) = mix(&value) {
        return transparent(color, opacity);
    }

    let open = value.find('(')?;
    let family = value.get(..open)?;
    let body = value.get(open + 1..)?.strip_suffix(')')?;

    if !matches!(family, "rgb" | "rgba" | "hsl" | "hsla" | "hwb") || body.contains(['(', ')']) {
        return None;
    }

    let body = js::trim(body);
    let legacy = body.contains(',');

    if legacy && (body.contains('/') || family == "hwb") {
        return None;
    }

    let parts: Vec<&str> = body
        .split(if legacy { ',' } else { '/' })
        .map(js::trim)
        .collect();

    if (!legacy && parts.len() > 2) || (legacy && !matches!(parts.len(), 3 | 4)) {
        return None;
    }

    let channels: Vec<&str> = if legacy {
        parts.iter().take(3).copied().collect()
    } else {
        split_whitespace(parts.first().copied().unwrap_or_default())
    };
    let alpha = parts.get(if legacy { 3 } else { 1 }).copied();

    let [first, second, third] = channels.as_slice() else {
        return None;
    };
    let opacity = match alpha {
        None => 1.0,
        Some(alpha) => number(alpha, true)?,
    };
    let percent = alpha.is_some_and(|alpha| alpha.ends_with('%'));
    let opacity = clamp(opacity / if percent { 100.0 } else { 1.0 });
    let rgb: [f64; 3] = if family.starts_with("rgb") {
        let percentages = channels.iter().filter(|part| part.ends_with('%')).count();

        if legacy && percentages > 0 && percentages != channels.len() {
            return None;
        }

        let mut rgb = [0.0; 3];

        for (channel, part) in rgb.iter_mut().zip([first, second, third]) {
            let value = number(part, true)?;

            *channel = clamp(value / if part.ends_with('%') { 100.0 } else { 255.0 });
        }

        rgb
    } else {
        let (amount, unit) = angle(first)?;

        if !second.ends_with('%') || !third.ends_with('%') {
            return None;
        }

        let degrees = amount
            * match unit {
                "turn" => 360.0,
                "grad" => 0.9,
                "rad" => 180.0 / std::f64::consts::PI,
                _ => 1.0,
            };
        let second = number(second, true);
        let third = number(third, true);
        let (Some(second), Some(third)) = (second, third) else {
            return None;
        };

        if !degrees.is_finite() {
            return None;
        }

        let hwb = family == "hwb";
        let hue = ((degrees % 360.0) + 360.0) % 360.0;
        let saturation = if hwb { 1.0 } else { clamp(second / 100.0) };
        let lightness = if hwb { 0.5 } else { clamp(third / 100.0) };
        let amplitude = saturation * min(lightness, 1.0 - lightness);
        let mut rgb = [0.0, 8.0, 4.0].map(|offset: f64| {
            let sector = (offset + hue / 30.0) % 12.0;

            lightness - amplitude * max(-1.0, min(min(sector - 3.0, 9.0 - sector), 1.0))
        });

        if hwb {
            let white = clamp(second / 100.0);
            let black = clamp(third / 100.0);

            for channel in &mut rgb {
                *channel = if white + black >= 1.0 {
                    white / (white + black)
                } else {
                    *channel * (1.0 - white - black) + white
                };
            }
        }

        rgb
    };
    let mut output = String::with_capacity(9);

    output.push('#');

    for channel in [rgb[0], rgb[1], rgb[2], opacity] {
        let byte = round(channel * 255.0);
        let digits = js::radix(byte, 16);

        if digits.len() < 2 {
            output.push('0');
        }

        output.push_str(&digits);
    }

    Some(output)
}

/// Matches `^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d*)?|\.\d+)%\s*,\s*transparent\s*\)$`.
fn mix(value: &str) -> Option<(&str, &str)> {
    let body = value.strip_prefix("color-mix(")?.strip_suffix(')')?;
    let body = body
        .trim_start_matches(js::is_whitespace)
        .strip_prefix("in")?;
    let rest = body.trim_start_matches(js::is_whitespace);

    if rest.len() == body.len() {
        return None;
    }

    let body = rest
        .strip_prefix("srgb")?
        .trim_start_matches(js::is_whitespace)
        .strip_prefix(',')?
        .trim_start_matches(js::is_whitespace);
    let body = body
        .trim_end_matches(js::is_whitespace)
        .strip_suffix("transparent")?
        .trim_end_matches(js::is_whitespace)
        .strip_suffix(',')?
        .trim_end_matches(js::is_whitespace)
        .strip_suffix('%')?;
    let (color, opacity) = body.rsplit_once(js::is_whitespace)?;
    let color = color.trim_end_matches(js::is_whitespace);

    if color.is_empty() || opacity.is_empty() || !OPACITY.matches(opacity) {
        return None;
    }

    Some((color, opacity))
}

/// Scales the alpha of a color by a percentage, as premultiplied mixing with `transparent` does.
fn transparent(color: &str, opacity: &str) -> Option<String> {
    let opacity = js::to_number(opacity);
    let color = parse(color)?;

    if opacity > 100.0 {
        return None;
    }

    if color == "transparent" {
        return Some(color);
    }

    let digits = color.strip_prefix('#')?;
    let full: String = if digits.len() <= 4 {
        digits.chars().flat_map(|digit| [digit, digit]).collect()
    } else {
        digits.to_owned()
    };
    let alpha = full
        .get(6..8)
        .map_or(Some(255), |alpha| u8::from_str_radix(alpha, 16).ok())?;
    let byte = round(f64::from(alpha) * opacity / 100.0);
    let mut output = String::with_capacity(9);

    output.push('#');
    output.push_str(full.get(..6)?);

    let digits = js::radix(byte, 16);

    if digits.len() < 2 {
        output.push('0');
    }

    output.push_str(&digits);

    Some(output)
}

/// The spelling `\d+(?:\.\d*)?|\.\d+` of a `color-mix()` percentage.
const OPACITY: Decimal = Decimal {
    exponent: Exponent::None,
    fraction: Fraction::Optional,
    sign: false,
};

/// Matches `^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$`.
fn hex(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|digits| {
        matches!(digits.len(), 3 | 4 | 6 | 8)
            && digits
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Splits like `split(/\s+/)` on text without surrounding whitespace.
fn split_whitespace(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return vec![""];
    }

    text.split(js::is_whitespace)
        .filter(|part| !part.is_empty())
        .collect()
}

/// The spelling `[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?` of lowercased color numbers.
const NUMBER: Decimal = Decimal {
    exponent: Exponent::Lower,
    fraction: Fraction::Optional,
    sign: true,
};

/// Matches `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$` and converts the finite value.
fn number(input: &str, percentage: bool) -> Option<f64> {
    let digits = input.strip_suffix('%').unwrap_or(input);

    if !NUMBER.matches(digits) || (!percentage && input.ends_with('%')) {
        return None;
    }

    Some(js::to_number(digits)).filter(|value| value.is_finite())
}

/// Matches `^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$`.
fn angle(input: &str) -> Option<(f64, &str)> {
    let length = NUMBER.prefix(input);
    let unit = input.get(length..)?;

    if length == 0 || !matches!(unit, "" | "deg" | "grad" | "rad" | "turn") {
        return None;
    }

    Some((js::to_number(input.get(..length)?), unit))
}

fn clamp(value: f64) -> f64 {
    max(0.0, min(1.0, value))
}

/// `Math.min` for two numbers, propagating `NaN`.
fn min(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }

    left.min(right)
}

/// `Math.max` for two numbers, propagating `NaN`.
fn max(left: f64, right: f64) -> f64 {
    if left.is_nan() || right.is_nan() {
        return f64::NAN;
    }

    left.max(right)
}

/// `Math.round` for a byte channel, rounding halves up.
fn round(value: f64) -> u64 {
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };

    // Channels are clamped to 0..=255 before rounding.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "Clamped channels are small nonnegative integers."
    )]
    let byte = rounded.max(0.0) as u64;

    byte
}
