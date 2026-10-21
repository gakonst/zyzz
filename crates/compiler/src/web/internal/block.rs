//! Represents ordered descriptor and declaration blocks independently of parsing.

use std::sync::Arc;

use crate::style::NamedStyle;
use crate::web::internal::contributions::Scalar;

/// One authored descriptor, element declaration fragment, or nested descriptor block.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    /// A nested block under a header.
    Block {
        /// Descriptors and nested blocks in authored order.
        entries: Vec<Entry>,
        /// CSS rule header.
        header: Arc<str>,
    },
    /// One descriptor.
    Descriptor {
        /// Descriptor name.
        name: Arc<str>,
        /// Descriptor value.
        value: Scalar,
    },
    /// Ordinary declarations serialized by the CSS compiler.
    Style(Arc<NamedStyle>),
}

/// Renders a structured block while delegating ordinary property serialization to the caller.
pub fn render<'s>(
    output: &mut String,
    entries: &'s [Entry],
    style: &mut dyn FnMut(&mut String, &'s NamedStyle),
) {
    for entry in entries {
        match entry {
            Entry::Style(value) => style(output, value),
            Entry::Block { entries, header } => {
                output.push_str(header);
                output.push('{');
                render(output, entries, style);
                output.push('}');
            }
            Entry::Descriptor { name, value } => {
                output.push_str(name);
                output.push(':');
                value.write(output);
                output.push(';');
            }
        }
    }
}
