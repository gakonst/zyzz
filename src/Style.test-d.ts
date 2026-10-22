/**
 * Checks consumer inference and rejected inputs through the public Style API.
 * @module
 */
import * as Borders from '../test/fixtures/Borders.js'
import * as BorderShorthand from '../test/fixtures/BorderShorthand.js'
import { components } from '../test/fixtures/components.js'
import * as Geometry from '../test/fixtures/Geometry.js'
import * as Identifiers from '../test/fixtures/Identifiers.js'
import * as Interaction from '../test/fixtures/Interaction.js'
import * as Logical from '../test/fixtures/Logical.js'
import * as Scalars from '../test/fixtures/Scalars.js'
import * as Scrolling from '../test/fixtures/Scrolling.js'
import * as Snapping from '../test/fixtures/Snapping.js'
import * as Tables from '../test/fixtures/Tables.js'
import * as TextDecoration from '../test/fixtures/TextDecoration.js'
import * as TextFlow from '../test/fixtures/TextFlow.js'
import * as TextTimeline from '../test/fixtures/TextTimeline.js'
import { describe, expectTypeOf, test } from 'vite-plus/test'
import { style, Style } from 'zyzz'
import * as Theme from './internal/Theme.js'
import * as Config from './internal/Configuration.js'

describe('compatibility properties', () => {
  test('preserves vendor domains and new property grammars', () => {
    style({
      WebkitFontSmoothing: 'antialiased',
      MozOsxFontSmoothing: 'grayscale',
      WebkitAnimationDelay: '0s, 250ms',
      WebkitAlt: 'attr(data-label)',
      WebkitTextCombine: 'horizontal',
      WebkitRubyPosition: 'before',
      WebkitBackgroundClip: 'padding',
      WebkitPerspective: 800,
      glyphOrientationVertical: 90,
      WebkitColumnBreakInside: 'avoid',
      rowRule: '1px solid red',
      rowRuleColor: 'repeat(2, red, blue)',
      ruleInset: '10px 20% / overlap-join',
      viewTransitionGroup: 'card',
      whiteSpaceTrim: 'discard-before discard-after',
    })

    // @ts-expect-error Mozilla does not accept WebKit smoothing keywords.
    style({ MozOsxFontSmoothing: 'antialiased' })
    // @ts-expect-error WebKit does not accept Mozilla smoothing keywords.
    style({ WebkitFontSmoothing: 'grayscale' })
    // @ts-expect-error Legacy WebKit text combining uses horizontal, not all.
    style({ WebkitTextCombine: 'all' })
    // @ts-expect-error Legacy glyph orientation accepts only zero or ninety degrees.
    style({ glyphOrientationVertical: 45 })
    // @ts-expect-error Gap decoration widths exclude percentages.
    style({ rowRuleWidth: '10%' })
    // @ts-expect-error Gap decoration widths must be nonnegative.
    style({ rowRuleWidth: '-1px' })
    // @ts-expect-error Gap decoration colors exclude line styles.
    style({ rowRuleColor: 'solid' })
    // @ts-expect-error Legacy break-inside excludes break-before keywords.
    style({ WebkitColumnBreakInside: 'always' })
  })
})

describe('intrinsic scalar prefixes', () => {
  test('rejects optional unknown keys on broad style annotations', () => {
    const box = {} as Style.Properties & { widht?: string }

    // @ts-expect-error Broad annotations must still reject unknown keys.
    Style.define({ box })
  })
  test('preserves component domains through public authoring', () => {
    style({
      containIntrinsicSize: 'auto 80px auto 40px',
      containIntrinsicWidth: 'auto none',
      fontSizeAdjust: 'cap-height .7',
    })
    // @ts-expect-error Intrinsic sizes exclude percentages.
    style({ containIntrinsicWidth: '10%' })
    // @ts-expect-error Metric prefixes need a following value.
    style({ fontSizeAdjust: 'cap-height' })
  })
})

describe('timeline range endpoints', () => {
  test('retains typed names and offsets', () => {
    style({
      animationRangeStart: 'entry 20%',
      animationRangeEnd: 'exit -10px',
      timelineTriggerActiveRangeStart: 'auto',
    })
    // @ts-expect-error Range offsets cannot use time units.
    style({ animationRangeStart: '1s' })
    // @ts-expect-error Auto is exclusive to active trigger endpoints.
    style({ animationRangeEnd: 'auto' })
  })
})

describe('compound scalar declarations', () => {
  test('typed tuples preserve scalar domains', () => {
    style({
      borderImageSlice: 'fill 10% 20%',
      borderImageWidth: '1 auto 20% 3px',
      borderImageOutset: '1 2px',
      scrollbarColor: 'red blue',
      MozBorderTopColors: 'red blue green yellow black white',
      interestDelay: '1s 200ms',
      viewTimelineInset: 'auto 10%, 20px',
      hyphenateLimitChars: 'auto 3 2',
    })
    // @ts-expect-error Scrollbar colors require two colors or auto.
    style({ scrollbarColor: 'red' })
    // @ts-expect-error Border image slices exclude lengths.
    style({ borderImageSlice: '1px' })
    // @ts-expect-error Outset excludes percentages.
    style({ borderImageOutset: '10%' })
    // @ts-expect-error Interest delays use time dimensions.
    style({ interestDelay: '1px' })
    // @ts-expect-error A fill marker needs numeric components.
    style({ borderImageSlice: 'fill' })
  })
})

describe('corner and layout declarations', () => {
  test('typed curvature and reset values preserve property domains', () => {
    style({
      cornerShape: 'superellipse(2) bevel',
      cornerTopLeftShape: 'round',
      all: 'initial',
      gridGap: '10px 20px',
      justifySelf: 'safe end',
      textBoxEdge: 'cap alphabetic',
      positionTryOrder: 'most-width',
    })
    // @ts-expect-error Curvature is a keyword or function rather than a bare number.
    style({ cornerShape: 2 })
    // @ts-expect-error All accepts only CSS-wide values or deferred substitution.
    style({ all: 'red' })
    // @ts-expect-error Legacy is exclusive to justify-items.
    style({ justifySelf: 'legacy' })
    // @ts-expect-error Text box edges retain separate over and under keyword domains.
    style({ textBoxEdge: 'cap ex' })
  })
})

describe('prefixed declarations', () => {
  test('vendor keywords preserve prefixes and domains', () => {
    style({
      MozAppearance: 'button',
      MsAccelerator: 'true',
      MsScrollbar3dlightColor: 'red',
      WebkitBorderBefore: '2px solid red',
      WebkitTextStrokeWidth: '2px',
      WebkitMaskPositionX: 'left, 20%',
      WebkitLineClamp: 2,
    })
    // @ts-expect-error Prefix spelling is part of the public property name.
    style({ webkitUserSelect: 'none' })
    // @ts-expect-error CSS true is a keyword rather than a JavaScript boolean.
    style({ MsAccelerator: true })
    // @ts-expect-error Vendor keyword domains remain distinct.
    style({ WebkitUserSelect: 'element' })
    // @ts-expect-error Scroll limits exclude percentages.
    style({ MsScrollLimitXMin: '20%' })
    // @ts-expect-error Text stroke widths exclude percentages.
    style({ WebkitTextStrokeWidth: '20%' })
  })
})

describe('percentage values', () => {
  test('percentages retain their property dimensions', () => {
    style({
      fontWidth: '125%',
      fontStretch: '120%',
      textSizeAdjust: '110%',
      zoom: '125%',
      opacity: '-20%',
      fillOpacity: '150%',
      strokeOpacity: 2,
      floodOpacity: '-25%',
      stopOpacity: 'calc(50% + 25%)',
    })
    // @ts-expect-error A percentage requires its unit even for zero.
    style({ fontWidth: 0 })
    // @ts-expect-error Font width excludes lengths.
    style({ fontWidth: '125px' })
    // @ts-expect-error Hexadecimal percentages are not CSS numeric tokens.
    style({ fontWidth: '0x10%' })
  })
})

describe('style', () => {
  test('geometric values expose structured transform shapes', () => {
    Style.define(Geometry.styles)

    for (const transform of Geometry.functions) style({ transform })

    style({
      aspectRatio: 'auto 16/9',
      rotate: '0 1 0 45deg',
      scale: '-1 50% 2',
      translate: 'calc(50% - 10px) 2px -3px',
    })
    style({
      transform: ['rotate(90deg)', 'translateX(20px) rotate(45deg) !important'],
      aspectRatio: 2,
      scale: 1.5,
    })
    // @ts-expect-error Transform names remain a finite function vocabulary.
    style({ transform: 'unknown(1)' })
    // @ts-expect-error Nonzero translations need units.
    style({ translate: 20 })
    // @ts-expect-error Scale factors do not use length units.
    style({ scale: '2px' })
    // @ts-expect-error Ratios do not use dimensional components.
    style({ aspectRatio: '16px/9px' })
  })

  test('combined line values retain typed width style and color components', () => {
    Style.define(BorderShorthand.styles)
    style({
      border: 0,
      borderBlock: 'red solid thin',
      borderInlineEnd: 'rgb(0 0 255) dashed calc(1px + 2px)',
      outline: 'auto thin red',
      columnRule: 'medium double blue',
    })
    // @ts-expect-error A nonzero number requires a length unit.
    style({ border: 5 })
    // @ts-expect-error Border widths do not accept percentages.
    style({ border: '50%' })
    // @ts-expect-error Arbitrary identifiers are not line components.
    style({ border: 'unknown' })
  })

  test('custom identifiers retain string authoring and declaration fallbacks', () => {
    Style.define(Identifiers.styles)
    style({
      animationName: ['Fade', 'Pulse !important'],
      anchorScope: '--Anchor, --Other',
      fontPalette: '--Palette',
      timelineScope: '--Scroll',
      triggerScope: 'all',
      page: 'Chapter',
    })
    // @ts-expect-error Identifiers cannot be authored as numbers.
    style({ animationName: 123 })
    // @ts-expect-error Identifiers cannot be authored as booleans.
    style({ containerName: false })
  })

  test('text and timeline groups retain public type constraints', () => {
    Style.define(TextTimeline.styles)
    style({
      hangingPunctuation: 'last first allow-end',
      masonryAutoFlow: 'ordered pack',
      positionVisibility: 'anchors-visible no-overflow',
      speakAs: 'digits spell-out',
      maskBorderRepeat: 'stretch round',
    })
    style({
      columnHeight: 'calc(20px + 2em)',
      lineHeightStep: '2em',
      shapeImageThreshold: 0.5,
      textDecorationInset: '1px 2px',
    })
    // @ts-expect-error Timeline axes are an explicit finite vocabulary.
    style({ viewTimelineAxis: 'horizontal' })
    // @ts-expect-error Height accepts lengths rather than percentages.
    style({ columnHeight: '50%' })
    // @ts-expect-error Delay requires a time unit.
    style({ interestDelayStart: 20 })
  })

  test('SVG geometry and text scalars preserve finite authoring', () => {
    Style.define(Scalars.styles)
    style({
      animationComposition: 'add, replace',
      scrollTimelineAxis: 'block, x',
      fontSynthesisPosition: 'none',
      caretAnimation: 'manual',
      caretShape: 'bar',
      zoom: 1.5,
    })
    style({
      x: 'calc(10% - 2px)',
      r: 'var(--radius)',
      stopColor: 'rgb(0 0 255)',
      stopOpacity: 0.5,
      strokeColor: 'red',
    })
    // @ts-expect-error SVG radii require a dimension for nonzero numbers.
    style({ r: 12 })
    // @ts-expect-error Caret keywords cannot be combined.
    style({ caretShape: 'bar block' })
    // @ts-expect-error Zoom excludes length units.
    style({ zoom: '150px' })
  })

  test('interaction properties', () => {
    Style.define(Interaction.styles)
    style({
      cursor: ['grab', 'grabbing !important'],
      pointerEvents: 'none',
      userSelect: 'all',
    })
    style({ resize: 'vertical', visibility: 'revert-layer' })
    Config.create().style({ cursor: 'zoom-in', pointerEvents: 'auto' })
    Theme.define({}).style({ userSelect: 'text', resize: 'both' })
    style({ cursor: 'url(cursor.png), pointer' })
    style({ pointerEvents: 'visiblePainted' })
    // @ts-expect-error Resize axes cannot be combined.
    style({ resize: 'horizontal vertical' })
    // @ts-expect-error Containment is outside the pinned user-select grammar.
    style({ userSelect: 'contain' })
    // @ts-expect-error Visibility is not opacity.
    style({ visibility: 0 })
    // @ts-expect-error Display keywords do not name visibility states.
    style({ visibility: 'none' })

    const interactionTheme = Theme.define({ spacing: { control: '8px' } })

    // @ts-expect-error Interaction keywords do not accept theme tokens.
    interactionTheme.style({ cursor: interactionTheme.tokens.spacing.control })
  })

  test('table properties', () => {
    Style.define(Tables.styles)
    style({ borderSpacing: [0, '1em !important'], tableLayout: 'fixed' })
    style({
      borderCollapse: 'revert-layer',
      captionSide: 'inherit',
      emptyCells: 'unset',
    })
    Config.create().style({ borderSpacing: '2px', tableLayout: 'auto' })
    Theme.define({}).style({ borderSpacing: '1rem', captionSide: 'bottom' })
    // @ts-expect-error Border spacing does not accept percentages.
    style({ borderSpacing: '10%' })
    style({ borderSpacing: '1px 2px' })
    // @ts-expect-error Table layout has a finite keyword domain.
    style({ tableLayout: 'flex' })
    // @ts-expect-error Empty cells use hide/show, not visibility keywords.
    style({ emptyCells: 'hidden' })
    // @ts-expect-error Caption alignment is not caption placement.
    style({ captionSide: 'center' })
    // @ts-expect-error Border collapse is not a border style.
    style({ borderCollapse: 'solid' })

    const tableTheme = Theme.define({ spacing: { gutter: '8px' } })

    // @ts-expect-error Unconstrained spacing tokens can contain percentages.
    tableTheme.style({ borderSpacing: tableTheme.tokens.spacing.gutter })
    // @ts-expect-error Named spacing tokens are not supported for border spacing.
    tableTheme.style({ borderSpacing: 'gutter' })
  })

  test('text decoration', () => {
    Style.define(TextDecoration.styles)
    style({
      textDecorationLine: ['overline underline', 'line-through !important'],
      textDecorationThickness: '10%',
      textUnderlineOffset: '-.2em',
    })

    const decorationTheme = Theme.define({
      color: { ink: '#06c' },
      textColor: { ink: '#f00' },
      spacing: { stroke: '2px' },
    })

    decorationTheme.style({
      textDecorationColor: 'ink',
      textDecorationThickness: 'stroke',
    })
    Config.create({ theme: decorationTheme }).style({
      textUnderlineOffset: decorationTheme.tokens.spacing.stroke,
    })
    Style.define({
      link: { textDecorationColor: decorationTheme.tokens.color.ink },
    })
    decorationTheme.style({
      // @ts-expect-error Text-only color groups do not map to decoration colors.
      textDecorationColor: decorationTheme.tokens.textColor.ink,
    })
    // @ts-expect-error Root decoration lengths remain token-free.
    style({ textDecorationThickness: 'stroke' })
    // @ts-expect-error None cannot be combined with line flags.
    style({ textDecorationLine: 'none underline' })
    // @ts-expect-error Line flags cannot be repeated.
    style({ textDecorationLine: 'underline underline' })
    // @ts-expect-error Decoration style is not a border style.
    style({ textDecorationStyle: 'groove' })
    // @ts-expect-error From-font is a thickness keyword, not an underline offset.
    style({ textUnderlineOffset: 'from-font' })
    style({ textDecoration: 'underline solid' })
    // @ts-expect-error Invalid numeric spellings remain checked in importance strings.
    style({ textDecorationThickness: '0x10px !important' })
  })

  test('text flow', () => {
    Style.define(TextFlow.styles)
    style({
      letterSpacing: ['normal', '-1px !important'],
      wordSpacing: '-.2em',
      textIndent: '10%',
    })

    const textTheme = Theme.define({
      spacing: { indent: '12px', portion: '10%' },
    })

    textTheme.style({ textIndent: 'indent', whiteSpace: 'pre-wrap' })
    Config.create({ theme: textTheme }).style({
      textIndent: textTheme.tokens.spacing.portion,
    })
    Style.define({ paragraph: { textIndent: textTheme.tokens.spacing.indent } })
    // @ts-expect-error Letter spacing excludes percentages.
    style({ letterSpacing: '10%' })
    // @ts-expect-error Word spacing excludes percentages in the supported grammar.
    style({ wordSpacing: '10% !important' })
    // @ts-expect-error Indentation does not accept auto.
    style({ textIndent: 'auto' })
    // @ts-expect-error Length-only text spacing cannot use unconstrained spacing tokens.
    textTheme.style({ letterSpacing: textTheme.tokens.spacing.portion })
    // @ts-expect-error Text keyword domains cannot use spacing tokens.
    textTheme.style({ whiteSpace: textTheme.tokens.spacing.indent })
    // @ts-expect-error Root indentation remains token-free.
    style({ textIndent: 'indent' })
    style({ textIndent: '2em hanging' })
    // @ts-expect-error Unknown wrapping values do not widen the finite domain.
    style({ overflowWrap: 'all' })
    style({ textOverflow: '"..."' })
    style({ whiteSpaceCollapse: 'preserve' })
    // @ts-expect-error Numeric spellings remain checked through fallback importance.
    style({ letterSpacing: ['normal', '0x10px !important'] })
  })

  test('scroll snapping', () => {
    Style.define(Snapping.styles)
    style({
      scrollSnapType: ['both proximity', 'both mandatory !important'],
      scrollSnapAlign: 'center end',
      scrollSnapStop: 'normal',
    })

    const snapTheme = Theme.define({ spacing: { edge: '10px' } })

    snapTheme.style({
      scrollPadding: 'edge',
      scrollSnapType: 'inline mandatory',
    })
    Config.create({ theme: snapTheme }).style({
      scrollSnapType: 'block proximity',
      scrollSnapAlign: 'none start',
    })
    // @ts-expect-error Strictness needs an axis.
    style({ scrollSnapType: 'mandatory' })
    // @ts-expect-error None cannot be combined with strictness.
    style({ scrollSnapType: 'none mandatory' })
    // @ts-expect-error Snap axes are finite.
    style({ scrollSnapType: 'horizontal mandatory' })
    // @ts-expect-error Alignment accepts at most two keywords.
    style({ scrollSnapAlign: 'start center end' })
    // @ts-expect-error CSS-wide keywords apply to the whole value.
    style({ scrollSnapAlign: 'inherit center' })
    // @ts-expect-error Stop values are not snap strictness values.
    style({ scrollSnapStop: 'mandatory' })
    // @ts-expect-error Token groups do not map to snap keyword domains.
    snapTheme.style({ scrollSnapType: snapTheme.tokens.spacing.edge })
    // @ts-expect-error Invalid entries remain invalid inside fallbacks.
    style({ scrollSnapType: ['x', 'mandatory !important'] })
  })

  test('scrolling properties', () => {
    Style.define(Scrolling.styles)
    style({
      scrollAxisLock: ['auto', 'none !important'],
      scrollMargin: '-2px !important',
      scrollPaddingInline: ['auto', '10%'],
    })

    // @ts-expect-error Axis locking accepts only auto or none.
    style({ scrollAxisLock: 'always' })

    const scrollTheme = Theme.define({
      spacing: { offset: '20px', portion: '10%' },
    })

    scrollTheme.style({ scrollPaddingTop: 'offset !important' })
    Config.create({ theme: scrollTheme }).style({
      scrollPaddingBlock: ['auto !custom', scrollTheme.tokens.spacing.portion],
    })
    Style.define({ box: { scrollPadding: scrollTheme.tokens.spacing.offset } })
    // @ts-expect-error Scroll margin excludes percentages.
    style({ scrollMarginTop: '10% !important' })
    // @ts-expect-error Scroll margin does not accept auto.
    style({ scrollMarginInline: 'auto' })
    // @ts-expect-error Scroll padding is not an intrinsic size.
    style({ scrollPadding: 'min-content' })
    // @ts-expect-error Root scroll padding remains token-free.
    style({ scrollPadding: 'offset' })
    // @ts-expect-error Unconstrained spacing tokens can contain percentages.
    scrollTheme.style({ scrollMargin: scrollTheme.tokens.spacing.portion })
    // @ts-expect-error Scroll margin token mapping awaits a length-only token domain.
    scrollTheme.style({ scrollMargin: 'offset' })
    // @ts-expect-error Overflow keywords are not overscroll behavior.
    style({ overscrollBehavior: 'hidden' })
    // @ts-expect-error Instant is a scrolling API option, not a CSS scroll-behavior value.
    style({ scrollBehavior: 'instant' })
    style({ overscrollBehavior: 'none contain' })
    // @ts-expect-error Numeric spellings are checked inside fallback arrays.
    style({ scrollPadding: ['auto', '0x10px !important'] })
  })

  test('borders and outlines', () => {
    Style.define({ box: Borders.styles })

    const borderTheme = Theme.define({
      color: { brand: '#fff' },
      borderColor: { brand: '#06c' },
      borderRadius: { round: '50%' },
    })

    borderTheme.style({
      borderInlineStartColor: 'brand !important',
      borderTopLeftRadius: 'round',
      outlineColor: 'brand',
    })
    Config.create({ theme: borderTheme }).style({
      borderBlockColor: ['#000 !custom', borderTheme.tokens.borderColor.brand],
    })
    // @ts-expect-error Border widths exclude percentages on physical sides.
    style({ borderTopWidth: '10%' })
    // @ts-expect-error Border widths exclude percentages on logical shorthands.
    style({ borderInlineWidth: '10% !important' })
    // @ts-expect-error Outline widths exclude percentages.
    style({ outlineWidth: '10%' })
    // @ts-expect-error Outline offsets exclude percentages.
    style({ outlineOffset: '10%' })
    // @ts-expect-error Border color tokens do not apply to outlines.
    borderTheme.style({ outlineColor: borderTheme.tokens.borderColor.brand })
    const round = borderTheme.tokens.borderRadius.round
    // @ts-expect-error Radius tokens cannot become stroke widths.
    borderTheme.style({ borderLeftWidth: round })
    // @ts-expect-error Hidden is a border style, not an outline style.
    style({ outlineStyle: 'hidden' })
    // @ts-expect-error Auto is an outline style, not a border style.
    style({ borderBlockStyle: 'auto' })
  })

  test('logical properties', () => {
    Style.define(Logical.styles)
    style({
      direction: 'rtl',
      writingMode: 'vertical-rl',
      inset: 'auto',
      inlineSize: 'auto',
    })

    const logicalTheme = Theme.define({
      spacing: { md: '12px' },
      color: { brand: '#fff' },
    })

    logicalTheme.style({
      inlineSize: 'md',
      insetBlock: 'md !important',
      paddingInline: ['1px !custom', 'md'],
    })
    Style.define({
      card: {
        minInlineSize: logicalTheme.tokens.spacing.md,
        top: logicalTheme.tokens.spacing.md,
      },
    })
    Config.create({ theme: logicalTheme }).style({
      blockSize: 'md',
      maxBlockSize: 'md',
      left: 'md',
      marginBlockEnd: 'md !important',
    })
    // @ts-expect-error Root logical dimensions remain token-free.
    style({ inlineSize: 'md' })
    // @ts-expect-error Padding cannot accept auto.
    style({ paddingInline: 'auto' })
    // @ts-expect-error None is exclusive to maximum dimensions.
    style({ minBlockSize: 'none' })
    // @ts-expect-error Color tokens cannot become dimensions.
    logicalTheme.style({ blockSize: logicalTheme.tokens.color.brand })
    // @ts-expect-error Invalid numeric spellings remain rejected on logical lengths.
    style({ insetInlineStart: '0x10px !important' })
    style({ marginInline: '1px 2px' })
    // @ts-expect-error Unknown writing modes cannot widen the enum.
    style({ writingMode: 'diagonal' })
  })

  test('intrinsic sizing', () => {
    style({
      width: 'min-content',
      height: 'max-content',
      inlineSize: 'fit-content !important',
      blockSize: 'max-content',
      minWidth: 'auto',
      minHeight: 'fit-content',
      minInlineSize: 'min-content',
      minBlockSize: 'auto',
      maxWidth: 'none',
      maxHeight: 'max-content',
      maxInlineSize: 'none',
      maxBlockSize: 'fit-content',
      flexBasis: 'content',
    })

    const sizingTheme = Theme.define({ spacing: { 'min-content': '24px' } })

    Config.create({ theme: sizingTheme }).style({
      width: ['min-content', sizingTheme.tokens.spacing['min-content']],
    })
    // @ts-expect-error None is not a preferred dimension.
    style({ width: 'none' })
    // @ts-expect-error Maximum dimensions do not accept auto.
    style({ maxWidth: 'auto' })
    // @ts-expect-error Content is exclusive to flex basis.
    style({ inlineSize: 'content' })
    // @ts-expect-error Intrinsic keywords do not become spacing values.
    style({ padding: 'min-content' })
    style({ width: 'fit-content(10px)' })
    // @ts-expect-error Theme spacing remains a literal length domain.
    Theme.define({ spacing: { small: 'min-content' } })
  })

  test('flex and overflow', () => {
    style({
      alignContent: 'space-between',
      alignSelf: 'auto',
      flexBasis: '25%',
      order: -2,
      overflow: ['hidden', 'clip !important'],
      overflowX: 'auto',
      overflowY: 'scroll',
    })

    const flexTheme = Theme.define({
      spacing: { basis: '60px' },
      color: { brand: '#fff' },
    })

    flexTheme.style({ flexBasis: 'basis !important' })
    Style.define({ item: { flexBasis: flexTheme.tokens.spacing.basis } })
    Config.create({ theme: flexTheme }).style({
      flexBasis: ['auto !custom', 'basis'],
    })
    // @ts-expect-error Root sizing has no token names.
    style({ flexBasis: 'basis' })
    // @ts-expect-error Flex basis cannot use color tokens.
    flexTheme.style({ flexBasis: flexTheme.tokens.color.brand })
    // @ts-expect-error Item alignment does not accept line-distribution keywords.
    style({ alignSelf: 'space-between' })
    // @ts-expect-error Overflow accepts only its standard scalar keywords.
    style({ overflow: 'none' })
    // @ts-expect-error Order is numeric, including its importance-string form.
    style({ order: '2' })
    // @ts-expect-error Sizing spellings remain checked through importance.
    style({ flexBasis: '0x10px !important' })
  })
})

describe('define', () => {
  test('literal definitions and readonly output', () => {
    const definition = Style.define(components)

    expectTypeOf(definition.styles[0]!.name).toEqualTypeOf<
      'card' | 'hidden' | 'label'
    >()
    expectTypeOf(definition.styles).toEqualTypeOf<
      Style.Definition<'card' | 'hidden' | 'label'>['styles']
    >()

    Style.define({
      valid: {
        color: '#fff',
        display: 'inherit',
        lineHeight: 1.5,
        margin: '-2rem',
        padding: 0,
      },
    })

    const typo = { card: { colour: '#fff', padding: '1rem' } } as const

    // @ts-expect-error Excess properties must also fail through aliased input.
    Style.define(typo)
    // @ts-expect-error Unknown CSS properties are rejected.
    Style.define({ card: { colour: '#fff' } })
    // @ts-expect-error Core has no numeric spacing tokens.
    Style.define({ card: { padding: 4 } })
    // @ts-expect-error Core has no named tokens.
    Style.define({ card: { color: 'blue.700' } })
    // @ts-expect-error Invalid enum values cannot widen the contract.
    Style.define({ card: { display: 'banana' } })
    Style.define({ card: { ':hover': { color: '#fff' } } })
    // @ts-expect-error Callbacks are outside the literal subset.
    Style.define({ card: () => ({ color: '#fff' }) })
    // @ts-expect-error Undefined is not an authored CSS value.
    Style.define({ card: { padding: undefined } })
    // @ts-expect-error Data cannot be mutated after validation.
    definition.styles.push({ declarations: [], name: 'card' })
    // @ts-expect-error Declaration values are readonly.
    definition.styles[0]!.declarations[0]!.value = '2px'
    // @ts-expect-error Percentages are not border-width values.
    Style.define({ card: { borderWidth: '10%' } })
  })

  test('numeric style names', () => {
    const numeric = Style.define({ 0: { color: '#fff' }, 1.5: { padding: 0 } })

    expectTypeOf(numeric.styles).toEqualTypeOf<
      Style.Definition<'0' | '1.5'>['styles']
    >()
  })

  test('union inputs', () => {
    const invalidUnion = {} as { color: '#fff' } | { colour: '#fff' }

    // @ts-expect-error Every possible union branch must have supported keys.
    Style.define({ card: invalidUnion })

    const overlappingUnion = {} as
      | { padding: 0 }
      | { colour: '#fff'; padding: 0 }

    // @ts-expect-error Shared valid properties must not hide a branch's typo.
    Style.define({ card: overlappingUnion })

    const callbackUnion = {} as (() => { color: '#fff' }) | { color: '#fff' }

    // @ts-expect-error A union with an executable branch is not literal data.
    Style.define({ card: callbackUnion })

    const validUnion = {} as { color: '#fff' } | { padding: 0 }

    expectTypeOf(Style.define({ card: validUnion }).styles).toEqualTypeOf<
      Style.Definition<'card'>['styles']
    >()
  })

  test('theme token domains and required options', () => {
    const theme = Theme.define({
      color: { brand: '#06c' },
      spacing: { 4: '1rem' },
    })
    const themed = Style.define(
      { card: { color: 'brand', padding: 4 } },
      { vars: theme },
    )

    expectTypeOf(themed.styles).toEqualTypeOf<
      Style.Definition<'card'>['styles']
    >()

    // @ts-expect-error Theme inference cannot widen to accept unknown tokens.
    Style.define({ card: { color: 'missing' } }, { vars: theme })
    // @ts-expect-error Tokens remain property-specific.
    Style.define({ card: { padding: 'brand' } }, { vars: theme })
    // @ts-expect-error Names require an explicitly supplied theme.
    Style.define({ card: { color: 'brand' } })

    type Tokens = { color: { brand: '#06c' }; spacing: { 4: '1rem' } }

    // @ts-expect-error A token-aware option bag requires a theme.
    const missingTheme: Style.define.Options<Tokens> = {}
    // @ts-expect-error A token-aware option bag cannot explicitly omit the theme.
    const undefinedTheme: Style.define.Options<Tokens> = { vars: undefined }

    void missingTheme
    void undefinedTheme

    const presentTheme: Style.define.Options<Tokens> = { vars: theme }

    expectTypeOf(
      Style.define({ card: { color: 'brand' } }, presentTheme).styles,
    ).toEqualTypeOf<Style.Definition<'card'>['styles']>()

    const optionalTheme = {} as { vars?: typeof theme | undefined }

    Style.define({ card: { color: '#fff' } }, optionalTheme)
    // @ts-expect-error A potentially absent theme cannot enable shorthand names.
    Style.define({ card: { color: 'brand' } }, optionalTheme)
    // @ts-expect-error Explicit generic arguments cannot omit the required options.
    Style.define<{ card: { color: 'brand' } }, Tokens>({
      card: { color: 'brand' },
    })

    if (optionalTheme.vars)
      Style.define({ card: { color: 'brand' } }, { vars: optionalTheme.vars })
  })
})

describe('style', () => {
  test('fallbacks and importance', () => {
    style({
      display: ['block', 'flex !important'],
      opacity: '0.5 !important',
      padding: [0, '8px !important'],
    })

    const configured = Config.create({
      theme: { color: { brand: '#06c' }, spacing: { md: '8px' } },
    })

    configured.style({
      color: [
        '#fff !custom',
        'brand !important',
        configured.theme.tokens.color.brand,
      ],
      padding: ['md !important', '0 !custom'],
    })
    Style.define({ card: { padding: ['1px', '2px !important'] } })
    // @ts-expect-error Fallbacks are nonempty.
    style({ color: [] })
    // @ts-expect-error Fallback elements cannot be undefined.
    style({ padding: ['8px', undefined] })
    // @ts-expect-error Nested fallback arrays are unsupported.
    style({ color: [['#fff']] })
    // @ts-expect-error Importance does not widen the property domain.
    style({ display: 'banana !important' })
    // @ts-expect-error Root styles remain token-free.
    style({ color: ['brand !important'] })
    // @ts-expect-error Tokens retain their domain in fallback arrays.
    configured.style({ padding: [configured.theme.tokens.color.brand] })
  })

  test('only spaced important suffixes are accepted', () => {
    const configured = Config.create({ theme: { color: { brand: '#06c' } } })

    expectTypeOf<
      Extract<
        Style.DeclarationProperties<{ color: { brand: '#06c' } }>['color'],
        `brand${string}`
      >
    >().toEqualTypeOf<
      | 'brand'
      | 'brand !important'
      | `brand/${number}`
      | `brand/${number} !important`
    >()

    configured.style({ color: 'brand !important' })
    style({ color: 'red !important', opacity: '0.5 !important' })
    // @ts-expect-error Bare importance markers are unsupported.
    style({ color: 'red!' })
    // @ts-expect-error Spaced bare importance markers are unsupported.
    style({ color: 'red !' })
    // @ts-expect-error Importance requires a preceding space.
    style({ color: 'red!important' })
    // @ts-expect-error Importance has one canonical spelling.
    style({ color: 'red !IMPORTANT' })
    // @ts-expect-error Whitespace cannot split the importance marker.
    style({ color: 'red ! important' })
    // @ts-expect-error Importance must end the value.
    style({ color: 'red !important ' })
    // @ts-expect-error Escaped importance keywords are unsupported.
    style({ color: 'red !impor\\74 ant' })
    // @ts-expect-error Comments cannot alter the importance suffix.
    style({ color: 'red !important/**/' })
    // @ts-expect-error Token names use the same importance suffix.
    configured.style({ color: 'brand!' })
    // @ts-expect-error Token importance requires a preceding space.
    configured.style({ color: 'brand!important' })
    // @ts-expect-error Every fallback uses the same importance suffix.
    style({ color: ['red', 'blue!'] })
    // @ts-expect-error Broad CSS value domains still check importance.
    style({ animationName: 'pulse!' })
  })

  test('length units and numeric spellings', () => {
    style({
      borderWidth: '1Q',
      height: ['100vh', '100dvh !important'],
      marginLeft: '-2cqi',
      padding: '1lh',
      width: '80ch',
    })

    const lengthTheme = Theme.define({ spacing: { space: '2cqi' } })

    Style.define(
      { card: { padding: 'space !important' } },
      { vars: lengthTheme },
    )
    // @ts-expect-error A time unit is not a CSS length.
    style({ width: '1ms' })
    // @ts-expect-error An unknown viewport suffix is not a CSS unit.
    style({ height: '1dvheight' })
    // @ts-expect-error Border widths still exclude percentages.
    style({ borderWidth: '1% !important' })
    // @ts-expect-error Length tokens still retain their property domains.
    lengthTheme.style({ color: lengthTheme.tokens.spacing.space })

    const extendedLengths = Theme.extend(lengthTheme, {
      spacing: { space: '1dvh' },
    })

    expectTypeOf(extendedLengths).toEqualTypeOf<typeof lengthTheme>()

    // @ts-expect-error Overrides cannot introduce token paths.
    Theme.extend(lengthTheme, { spacing: { missing: '1lh' } })
    // @ts-expect-error Overrides cannot change length tokens to colors.
    Theme.extend(lengthTheme, { spacing: { space: '#fff' } })

    // @ts-expect-error CSS lengths exclude hexadecimal numbers.
    style({ width: '0x10dvh' })
    // @ts-expect-error CSS lengths exclude binary numbers.
    style({ width: '0b10lh !important' })
    // @ts-expect-error CSS lengths exclude octal numbers.
    style({ padding: ['1px', '0o10cqi'] })
    // @ts-expect-error Theme lengths use the same decimal grammar.
    Theme.define({ spacing: { space: '0b10lh' } })
    style({
      width: '01dvh',
      height: '.5cqi',
      margin: '-1e-2lh',
      padding: '+0.5rem',
    })

    // @ts-expect-error CSS numbers cannot contain whitespace before the unit.
    style({ width: '10 dvh' })
    // @ts-expect-error Style.define checks the same numeric spellings.
    Style.define({ card: { padding: '0x10px' } })

    const configured = Config.create({
      theme: { color: { brand: '#06c' }, spacing: { md: '8px' } },
    })

    // @ts-expect-error Config-bound values use the same inferred checks.
    configured.style({ width: '0b10cqi !important' })

    const numericNames = Theme.define({ spacing: { '0x10px': '8px' } })

    numericNames.style({ padding: '0x10px !important' })

    // @ts-expect-error Binary values also fail for units with overlapping suffixes.
    style({ height: '0b10dvh' })
  })
})

describe('style', () => {
  test('columns and fragmentation preserve property domains', () => {
    style({
      columnCount: ['auto', '2 !important'],
      columnWidth: '12rem',
      columnGap: 'normal',
      columnFill: 'balance',
    })
    style({
      breakAfter: 'page',
      breakBefore: 'column',
      breakInside: 'avoid',
      columnSpan: 'all',
      orphans: 2,
      widows: 3,
    })

    const theme = Theme.define({
      color: { rule: '#06c' },
      spacing: { gutter: '8px' },
    })

    theme.style({
      columnRuleColor: 'rule',
      columnRuleStyle: 'solid',
      columnRuleWidth: 'thin',
    })
    Config.create({ theme }).style({ columnRuleColor: theme.tokens.color.rule })
    // @ts-expect-error Column widths exclude percentages.
    style({ columnWidth: '10%' })
    // @ts-expect-error Counts cannot use arbitrary keywords.
    style({ columnCount: 'none' })
    // @ts-expect-error Rule widths exclude percentages.
    style({ columnRuleWidth: '5%' })
    // @ts-expect-error Inside breaks cannot force a new column.
    style({ breakInside: 'column' })
    // @ts-expect-error Column widths do not accept percentage-capable spacing tokens.
    theme.style({ columnWidth: theme.tokens.spacing.gutter })
    style({ breakAfter: 'region' })
  })
})

describe('style', () => {
  test('layout and containment accept finite CSS domains', () => {
    style({
      backfaceVisibility: 'hidden',
      boxDecorationBreak: 'slice',
      clear: 'inline-end',
      contain: 'paint',
      contentVisibility: 'auto',
    })
    style({
      display: 'table-cell',
      float: 'inline-start',
      isolation: 'isolate',
      objectFit: 'scale-down',
      transformStyle: 'preserve-3d',
      zIndex: ['auto', '-1 !important'],
    })
    Config.create().style({ zIndex: 2, display: 'flow-root' })
    Theme.define({}).style({ contain: 'strict', objectFit: 'contain' })
    style({ contain: 'layout paint' })
    // @ts-expect-error Floats are not centering controls.
    style({ float: 'center' })
    // @ts-expect-error Object fit has no auto keyword.
    style({ objectFit: 'auto' })
    // @ts-expect-error Stacking accepts unitless integers, not lengths.
    style({ zIndex: '2px' })
    // @ts-expect-error Isolation does not accept blend modes.
    style({ isolation: 'multiply' })
    style({ display: 'inline flow-root' })
  })
})

describe('style', () => {
  test('background and color controls preserve token and keyword domains', () => {
    style({
      backgroundAttachment: 'fixed',
      backgroundBlendMode: 'multiply',
      backgroundClip: 'text',
      backgroundOrigin: 'content-box',
    })
    style({
      backgroundPositionX: '-2px',
      backgroundPositionY: '40%',
      backgroundRepeat: 'repeat-x',
      backgroundSize: ['auto', 'cover !important'],
      mixBlendMode: 'plus-lighter',
    })

    const theme = Theme.define({
      color: { auto: '#06c' },
      spacing: { gap: '2px' },
    })

    theme.style({ accentColor: 'auto', caretColor: theme.tokens.color.auto })
    Config.create({ theme }).style({
      colorScheme: 'only dark',
      forcedColorAdjust: 'none',
      printColorAdjust: 'exact',
    })
    // @ts-expect-error Background position axes use different side keywords.
    style({ backgroundPositionX: 'top' })
    style({ backgroundAttachment: 'scroll, fixed' })
    style({ backgroundSize: '10px 20px' })
    // @ts-expect-error Color controls do not accept length tokens.
    theme.style({ accentColor: theme.tokens.spacing.gap })
    // @ts-expect-error A blend mode is not a color value.
    style({ caretColor: 'multiply' })
    // @ts-expect-error Background geometry does not map spacing tokens.
    theme.style({ backgroundPositionX: theme.tokens.spacing.gap })
  })
})

describe('style', () => {
  test('supports paint tokens and bounded SVG domains', () => {
    style({
      fill: 'none',
      stroke: '#06c',
      fillOpacity: 0.5,
      strokeWidth: '2px',
      strokeDashoffset: '-5%',
      strokeLinecap: 'round',
      strokeLinejoin: 'bevel',
      strokeMiterlimit: 2,
      fillRule: 'evenodd',
      clipRule: 'nonzero',
      paintOrder: 'stroke',
      shapeRendering: 'crispEdges',
      textRendering: 'optimizeLegibility',
      vectorEffect: 'non-scaling-stroke',
      colorInterpolationFilters: 'linearRGB',
      floodColor: 'black',
      floodOpacity: 0.2,
      lightingColor: 'white',
      strokeOpacity: 0.5,
    })

    const zyzz = Config.create({ theme: { color: { ink: '#06c' } } })

    zyzz.style({ fill: 'ink', stroke: zyzz.theme.tokens.color.ink })
    style({ fill: 'url(#gradient)' })
    style({ paintOrder: 'stroke fill' })
    style({ strokeWidth: 2 })
    // @ts-expect-error Scalar paint keywords do not apply to filter colors.
    style({ floodColor: 'none' })
  })
})

describe('style', () => {
  test('supports bounded typography and emphasis tokens', () => {
    style({
      fontKerning: 'normal',
      fontOpticalSizing: 'auto',
      fontStretch: 'semi-expanded',
      fontSynthesisSmallCaps: 'none',
      fontSynthesisStyle: 'auto',
      fontSynthesisWeight: 'none',
      fontVariantCaps: 'all-small-caps',
      fontVariantEastAsian: 'jis04',
      fontVariantLigatures: 'no-common-ligatures',
      fontVariantNumeric: 'tabular-nums',
      fontVariantPosition: 'super',
      rubyAlign: 'space-around',
      rubyPosition: 'alternate over',
      textCombineUpright: 'all',
      textEmphasisColor: '#06c',
      textEmphasisPosition: 'over right',
      textEmphasisStyle: 'open sesame',
      textJustify: 'inter-character',
      textOrientation: 'upright',
    })

    const zyzz = Config.create({ theme: { color: { accent: '#06c' } } })

    zyzz.style({ textEmphasisColor: 'accent' })
    style({ fontVariantNumeric: 'tabular-nums slashed-zero' })
    style({ textEmphasisStyle: '"*"' })
    // @ts-expect-error Font stretch excludes length units.
    style({ fontStretch: '120px' })
    // @ts-expect-error Conflicting emphasis fill keywords are invalid.
    style({ textEmphasisStyle: 'open filled' })
  })
})

describe('style', () => {
  test('supports dimensioned times and finite motion keywords', () => {
    style({
      animationDelay: '-.5s',
      animationDuration: ['auto', '250ms !important'],
      animationDirection: 'alternate',
      animationFillMode: 'both',
      animationIterationCount: [2.5, 'infinite'],
      animationPlayState: 'paused',
      animationTimingFunction: 'ease-in-out',
      transitionDelay: '-1e2ms',
      transitionDuration: '0s',
      transitionTimingFunction: 'linear',
      transitionBehavior: 'allow-discrete',
    })
    // @ts-expect-error Even zero times require a unit.
    style({ animationDuration: 0 })
    // @ts-expect-error Times cannot use length units.
    style({ transitionDelay: '2px' })
    // @ts-expect-error Nondecimal times are not CSS dimensions.
    style({ animationDelay: '0x10s' })
    style({ transitionDuration: '1s, 2s' })
    // @ts-expect-error Transition duration has no auto keyword.
    style({ transitionDuration: 'auto' })
  })
})

describe('grid tracks and placement', () => {
  test('supports flexible tracks and bounded line placement', () => {
    style({
      gridAutoColumns: '1fr',
      gridAutoRows: '40px',
      gridAutoFlow: 'column dense',
      gridTemplateColumns: 'min-content',
      gridTemplateRows: 'subgrid',
      gridColumnStart: [1, '2 !important'],
      gridColumnEnd: 'span 2',
      gridRowStart: -1,
      gridRowEnd: 'auto',
    })
    style({ gridTemplateColumns: '1fr 2fr' })
    // @ts-expect-error Flexible units are limited to grid tracks.
    style({ width: '1fr' })
    // @ts-expect-error Spans cannot contain fractional counts.
    style({ gridColumnStart: 'span 1.5' })
    // @ts-expect-error Nondecimal fractional units are not CSS dimensions.
    style({ gridAutoColumns: '0x10fr' })
    style({
      gridRowStart: 'header',
      gridColumn: 'start / end',
      gridArea: '1 / 2 / 3 / 4',
    })
    // @ts-expect-error Negative spans are invalid.
    style({ gridColumnEnd: 'span -1' })
  })
})

describe('mask and image properties', () => {
  test('supports bounded masks and scalar positioning', () => {
    style({
      backgroundPosition: 'right',
      imageRendering: 'pixelated',
      maskClip: 'padding-box',
      maskComposite: 'exclude',
      maskMode: 'alpha',
      maskOrigin: 'content-box',
      maskPosition: '50%',
      maskRepeat: 'no-repeat',
      maskSize: 'cover',
      maskType: 'luminance',
      objectPosition: 'bottom',
      perspective: '300px',
      perspectiveOrigin: 'center',
      shapeMargin: '5%',
      transformBox: 'border-box',
      transformOrigin: '-5px',
    })
    style({ maskMode: 'alpha, luminance' })
    // @ts-expect-error Perspective distances exclude percentages.
    style({ perspective: '50%' })
    style({ maskSize: '50% 100%' })
    style({ transformOrigin: 'left top' })
  })
})

describe('list and input controls', () => {
  test('supports list markers, logical overscroll, and touch combinations', () => {
    style({
      appearance: 'none',
      lineBreak: 'strict',
      listStylePosition: 'inside',
      listStyleType: 'upper-roman',
      overflowAnchor: 'none',
      overscrollBehaviorBlock: 'contain',
      overscrollBehaviorInline: 'none',
      scrollbarWidth: 'thin',
      tabSize: 4,
      textSizeAdjust: 'none',
      textSpacingTrim: 'space-all',
      touchAction: 'pinch-zoom pan-left pan-up',
      unicodeBidi: 'plaintext',
    })
    // @ts-expect-error Conflicting directions cannot share a touch-action group.
    style({ touchAction: 'pan-left pan-right' })
    // @ts-expect-error Auto does not combine with gestures.
    style({ touchAction: 'auto pinch-zoom' })
    style({ listStyleType: 'custom-counter' })
    style({ tabSize: '20px' })
    // @ts-expect-error Text autoscaling excludes length units.
    style({ textSizeAdjust: '100px' })
  })
})

describe('style', () => {
  test('accepts canonical named colors throughout color and token domains', () => {
    style({
      color: 'rebeccapurple',
      backgroundColor: 'aliceblue',
      borderColor: 'red',
      accentColor: 'coral',
      caretColor: 'tomato',
      fill: 'gold',
      stroke: 'navy',
      columnRuleColor: 'gray',
      textDecorationColor: 'grey',
      textEmphasisColor: 'papayawhip',
    })

    const zyzz = Config.create({
      theme: {
        color: { red: 'blue', accent: { dark: 'gold', light: 'navy' } },
      },
    })

    zyzz.style({
      color: 'red',
      backgroundColor: zyzz.theme.tokens.color.red,
      fill: 'accent',
    })
    // @ts-expect-error Unknown color names remain outside the domain.
    style({ color: 'not-a-color' })
    style({ color: 'rEbEcCaPuRpLe' })
  })
})

describe('style', () => {
  test('accepts canonical system colors in literals and theme schemes', () => {
    style({
      color: 'CanvasText',
      backgroundColor: 'Canvas',
      borderColor: 'ButtonBorder',
      accentColor: 'AccentColor',
      caretColor: 'Highlight',
      fill: 'SelectedItem',
    })
    Config.create({
      theme: { color: { ink: { dark: 'CanvasText', light: 'FieldText' } } },
    })
  })
})

describe('style', () => {
  test('accepts container and intrinsic field sizing controls', () => {
    style({
      containerType: ['normal', 'inline-size scroll-state !important'],
      fieldSizing: 'content',
      interpolateSize: 'allow-keywords',
    })
    style({
      containerType: 'scroll-state size',
      fieldSizing: 'fixed',
      interpolateSize: 'numeric-only',
    })
    // @ts-expect-error Size modes are mutually exclusive.
    style({ containerType: 'size inline-size' })
    // @ts-expect-error Normal cannot be combined with containment modes.
    style({ containerType: 'normal scroll-state' })
    // @ts-expect-error Field sizing has no auto keyword.
    style({ fieldSizing: 'auto' })
    // @ts-expect-error Interpolation is an explicit keyword policy.
    style({ interpolateSize: true })
  })
})

describe('style', () => {
  test('accepts reading flow modes and numeric order fallbacks', () => {
    style({
      readingFlow: ['normal', 'flex-visual !important'],
      readingOrder: [0, '-1 !important'],
    })
    style({ readingFlow: 'source-order', readingOrder: 2 })
    // @ts-expect-error Reading flow is one mode.
    style({ readingFlow: 'flex-flow grid-rows' })
    // @ts-expect-error Reading order is not a dimension.
    style({ readingOrder: '2px' })
    // @ts-expect-error Reading order has no auto keyword.
    style({ readingOrder: 'auto' })
  })
})

describe('style', () => {
  test('accepts structural grid tracks through public authoring', () => {
    style({
      gridTemplateColumns: '[start] repeat(3, minmax(0, 1fr)) [end]',
      gridTemplateRows: 'fit-content(40px) 1fr',
      gridAutoRows: '20px 30px',
    })
    style({
      gridTemplateColumns: [
        '1fr 2fr',
        'repeat(auto-fit, minmax(80px, 1fr)) !important',
      ],
    })
    // @ts-expect-error Implicit tracks cannot repeat.
    style({ gridAutoColumns: 'repeat(2, 1fr)' })
    // @ts-expect-error Grid functions are not ordinary dimensions.
    style({ width: 'minmax(0, 1fr)' })
  })
})

describe('style', () => {
  test('accepts physical box lists and logical pairs', () => {
    style({
      margin: '8px auto',
      padding: '1px 2px 3px 4px',
      inset: '0 20% auto -1px',
      borderWidth: '1px 2px',
      gap: '4px 8px',
    })
    style({
      marginInline: '-1px auto',
      paddingBlock: '1px 2px',
      scrollMargin: '1px 2px 3px 4px',
      scrollPaddingInline: '10% auto',
    })
    // @ts-expect-error Longhands still accept a single length.
    style({ paddingLeft: '1px 2px' })
    // @ts-expect-error Auto is not a padding item.
    style({ padding: 'auto 2px' })
  })
})

describe('style', () => {
  test('supports motion lists and structured easing functions', () => {
    style({
      animationDelay: '-1s, 0s',
      animationDirection: 'alternate, reverse',
      animationDuration: 'auto, 1s',
      animationFillMode: 'both, forwards',
      animationIterationCount: '2.5, infinite',
      animationPlayState: 'running, paused',
      animationTimingFunction: 'cubic-bezier(0, -1, 1, 2), steps(2, jump-none)',
      transitionBehavior: 'normal, allow-discrete',
      transitionDuration: ['1s, 2s', '250ms, 500ms !important'],
      transitionTimingFunction: 'linear(0, .5 25% 75%, 1)',
    })
    // @ts-expect-error Unknown easing functions are outside the structural grammar.
    style({ transitionTimingFunction: 'spring(1)' })
    // @ts-expect-error A duration list must start with a time.
    style({ transitionDuration: '20px, 1s' })
    // @ts-expect-error A CSS-wide keyword cannot start a component list.
    style({ animationDirection: 'inherit, normal' })
  })
})

describe('style', () => {
  test('supports absolute functional colors across color properties', () => {
    style({
      backgroundColor: 'hsl(120deg 50% 50% / .5)',
      borderColor: 'hwb(120 20% 30%)',
      color: ['rgb(255, 0, 0)', 'oklch(.5 .1 120) !important'],
      fill: 'lab(50% 20 -30)',
      outlineColor: 'color(display-p3 .1 .2 .3)',
      stroke: 'oklab(.5 .1 -.1)',
      textDecorationColor: 'lch(50 30 120)',
    })
    // @ts-expect-error Unknown function names are rejected by the structural type.
    style({ color: 'cmyk(0, 0, 0, 1)' })
    // @ts-expect-error Functions require a closing delimiter.
    style({ color: 'rgb(0 0 0' })
  })
})

describe('style', () => {
  test('supports border shorthand lists and elliptical radii', () => {
    style({
      borderBlockColor: 'red rgb(0 0 255)',
      borderColor: 'red green blue gold',
      borderInlineStyle: 'solid dashed',
      borderRadius: ['10px/20%', '1px 2px / 3px 4px 5px 6px !important'],
      borderStyle: 'solid dashed dotted double',
      borderTopLeftRadius: '10px 20%',
      borderWidth: 'thin medium thick 2px',
      outlineWidth: 'thin',
    })
    // @ts-expect-error Individual border color longhands take one color.
    style({ borderLeftColor: 'red blue' })
    // @ts-expect-error Individual border style longhands take one style.
    style({ borderTopStyle: 'solid dashed' })
    // @ts-expect-error Radius longhands use space-separated axes without a slash.
    style({ borderTopLeftRadius: '10px/20px' })
    // @ts-expect-error SVG stroke widths do not accept border width keywords.
    style({ strokeWidth: 'thin' })
  })
})

describe('style', () => {
  test('supports compatible font and containment keyword groups', () => {
    style({
      contain: 'layout style paint',
      fontSynthesis: 'style weight small-caps',
      fontVariantEastAsian: 'jis78 full-width ruby',
      fontVariantLigatures: 'no-common-ligatures contextual',
      fontVariantNumeric: 'oldstyle-nums tabular-nums slashed-zero',
    })
    // @ts-expect-error Standalone keywords cannot introduce groups.
    style({ fontVariantNumeric: 'normal tabular-nums' })
    // @ts-expect-error Unsupported leading keywords are rejected structurally.
    style({ fontSynthesis: 'bold style' })
  })
})

describe('style', () => {
  test('supports dimensional math inside scalar and list values', () => {
    style({
      animationDuration: 'min(1s, 500ms), calc(1s + 20ms)',
      borderRadius: 'calc(10px / 2) / max(10px, 20%)',
      gridTemplateColumns: 'minmax(calc(10px + 2px), 1fr)',
      opacity: 'calc(1 / 2)',
      padding: 'calc(1px + 2px) max(2px, 1%)',
      width: 'clamp(10px, 50%, 100px)',
    })
    // @ts-expect-error Unknown math function names are outside the supported structural type.
    style({ width: 'multiply(1px, 2)' })
    // @ts-expect-error Easing properties do not take arbitrary dimensional math.
    style({ transitionTimingFunction: 'calc(1 + 2)' })
  })
})

describe('style', () => {
  test('supports deferred custom-property substitution in every property domain', () => {
    style({
      animationTimingFunction: 'var(--easing, ease)',
      color: 'rgb(var(--channels) / var(--alpha, .5))',
      display: 'var(--display, block)',
      fontVariantNumeric: 'var(--numeric, tabular-nums)',
      gridTemplateColumns: 'var(--tracks, 1fr 2fr)',
      padding: 'var(--spacing, 1px 2px)',
      width: 'calc(100% - var(--gap, 10px))',
    })
    // @ts-expect-error Custom properties still require their double-hyphen spelling.
    style({ display: 'var(display)' })
    // @ts-expect-error Variable expressions do not add arbitrary property names.
    style({ imaginaryProperty: 'var(--anything)' })
  })
})

describe('compound', () => {
  describe('style', () => {
    test('accepts every compound fixture through public style definitions', () => {
      style({
        animation: 'fade 1s ease',
        background: 'url(image.png) center / cover no-repeat red',
        boxShadow: 'inset 0 0 2px red, 2px 3px 4px blue',
        fill: 'url(#gradient) red',
        font: 'italic 16px/1.5 sans-serif',
        grid: '100px / 1fr 2fr',
        maskSize: '10px 20px, contain',
        transition: 'opacity 200ms ease-in',
        shapeImageThreshold: [-1, 2, '50%'],
        strokeDashoffset: -2,
      })
    })

    test('retains position prefixes inside compound shorthands', () => {
      style({
        background: [
          'center top / cover no-repeat url(image.png)',
          '50%50%/cover',
          'calc(50% - 1px) top / cover !important',
        ],
        mask: ['left top / contain no-repeat url(mask.svg)', 'center/cover'],
        offset: ['left top path("M0 0L1 1")', '0 path("M0 0L1 1")'],
      })

      Style.define({
        card: {
          background: 'left top / cover url(image.png)',
          mask: '50%50%/cover',
          offset: 'center path("M0 0L1 1")',
        },
      })

      // @ts-expect-error Unknown position prefixes remain rejected.
      style({ background: 'middle / cover' })
      // @ts-expect-error Unknown mask prefixes remain rejected.
      style({ mask: 'banana' })
      // @ts-expect-error Unknown offset prefixes remain rejected.
      style({ offset: 'banana' })
    })

    test('preserves custom-property scalars, case, fallbacks, and importance', () => {
      style({
        '--Accent': '#arbitrary-text',
        '--accent': ['red', 'blue !important'],
        '--count': 2,
        '--empty': '',
      })
      Style.define({ card: { '--data': '"a;b:c"', color: 'var(--Accent)' } })
      // @ts-expect-error Custom declarations are CSS scalars.
      style({ '--enabled': true })
      // @ts-expect-error Custom declarations cannot contain records.
      style({ '--data': { value: 'red' } })
      // @ts-expect-error Arbitrary non-custom properties remain rejected.
      style({ backgroundColour: 'red' })
      // @ts-expect-error Ordinary property validation is retained beside custom properties.
      style({ '--accent': 'red', padding: 'red' })
    })

    test('accepts case-insensitive literals while keeping tokens case-sensitive', () => {
      style({
        color: '  ReD\t',
        display: 'FlEx',
        padding: ' 2PX !important',
        transform: 'RoTaTe(45DEG)',
      })
      Style.define({
        card: {
          color: ['BLUE', 'ReD !important', '#ABC !important'],
          margin: '1EM',
        },
      })

      const theme = Theme.define({
        color: { Brand: 'blue' },
        spacing: { Gap: '2px' },
      })

      theme.style({ color: 'ReD !custom', padding: '2PX !custom' })
      theme.style({ color: 'Brand', padding: 'Gap' })
      Config.create({ theme, layers: ['components'] }).style({
        '@layer components': { color: 'ReD !custom', padding: '2PX !custom' },
      })
      // @ts-expect-error Case folding cannot make an unknown keyword valid.
      style({ display: 'FleEx' })
      // @ts-expect-error Hex checks still apply to mixed-case authoring.
      style({ color: '#ABG' })
      // @ts-expect-error Unit case does not bypass nonnegative dimensions.
      style({ padding: '-1PX' })
      // @ts-expect-error Surrounding whitespace does not bypass nonnegative dimensions.
      style({ padding: ' -1PX ! important  ' })
      // @ts-expect-error Keyword case does not bypass integer grid spans.
      style({ gridColumnStart: 'SPAN 1.5' })
      // @ts-expect-error Named theme tokens retain their original case.
      theme.style({ color: 'brand' })
      // @ts-expect-error Case-insensitive literals do not change token domains.
      theme.style({ padding: 'Brand' })
    })

    test('accepts CSS whitespace separators and equivalent zero spellings', () => {
      style({
        display: 'BlOcK\tFlow',
        alignItems: 'FiRsT\nBaSeLiNe',
        overflow: 'hidden\tauto',
      })
      style({
        padding: ['0e3', '-.0', '+00', '00.00 !important', '0e3 1px'],
        borderRadius: '0e3/0',
      })
      // @ts-expect-error Whitespace cannot split a numeric token from its unit.
      style({ padding: '1\tpx' })
      // @ts-expect-error Whitespace normalization retains integer span constraints.
      style({ gridColumnStart: 'SPAN\t1.5' })
      // @ts-expect-error Numeric normalization cannot turn an exponent token into an integer token.
      style({ order: '0e3 !important' })
      // @ts-expect-error Time values still require units even for zero.
      style({ animationDelay: '0e3 !important' })
    })

    test('accepts CSS identifier escapes without changing numeric token boundaries', () => {
      style({ color: '\\72 ed', display: 'bl\\6f ck', padding: '1\\70 x' })
      style({ color: '#\\66 00', display: 'block/**/flow' })
      style({ color: 'red/**/ !important' })
      // @ts-expect-error An escaped identifier cannot become a numeric dimension.
      style({ padding: '\\31 px' })
      // @ts-expect-error An escaped unit prefix cannot become a numeric exponent.
      style({ padding: '1\\65 2px' })
      // @ts-expect-error Escapes retain nonnegative dimension constraints.
      style({ padding: '-1\\70 x' })
      // @ts-expect-error Escaped punctuation does not create a hash token.
      style({ color: '\\23 abc' })
      // @ts-expect-error CSS keyword folding is ASCII-only.
      style({ color: 'blacK' })
    })

    test('preserves CSS numeric spelling and range constraints', () => {
      style({
        padding: ['01px', '+.5px', '1e2px', '-0px'],
        order: '+01 !important',
        opacity: '1e-1 !important',
      })
      // @ts-expect-error Leading zeroes do not bypass a nonnegative range.
      style({ padding: '-01px' })
      // @ts-expect-error CSS fractional syntax requires a digit after the dot.
      style({ padding: '1.px' })
      // @ts-expect-error JavaScript radix spellings do not become CSS dimensions with a sign.
      style({ padding: '+0x10px' })
      // @ts-expect-error Exponent number tokens are not integer tokens.
      style({ order: '1e0 !important' })
      // @ts-expect-error Positive integer properties cannot use a zero mantissa.
      style({ columnCount: '+00 !important' })
      // @ts-expect-error A trailing decimal point does not form a complete CSS number.
      style({ opacity: '1. !important' })
    })

    test('retains CSS integer spelling in grid indexes and named spans', () => {
      style({
        gridColumnEnd: 'span +01',
        gridColumn: '-01 / span 02 content',
        gridRow: 'header 2 / footer -1',
      })
      style({
        gridColumnStart: 'calc(1 + 2)',
        gridColumnEnd: 'span calc(1 + 2)',
      })
      // @ts-expect-error Grid indexes are nonzero integers.
      style({ gridRowStart: 0 })
      // @ts-expect-error Named spans retain integer constraints.
      style({ gridColumnEnd: 'span 1.5 content' })
      // @ts-expect-error Span counts must be positive even when a name comes first.
      style({ gridColumnEnd: 'content span -1' })
      // @ts-expect-error Every slash-separated index retains its constraints.
      style({ gridArea: '1 / 0 / 2 / 3' })
      // @ts-expect-error Placement longhands accept one line.
      style({ gridRowStart: '1 / 2' })
      // @ts-expect-error Row and column shorthands accept at most two lines.
      style({ gridColumn: '1 / 2 / 3' })
      // @ts-expect-error Area shorthands accept at most four lines.
      style({ gridArea: '1 / 2 / 3 / 4 / 5' })
      // @ts-expect-error Dimension tokens cannot be grid line indexes.
      style({ gridRowStart: '1px' })
      // @ts-expect-error Exponent tokens do not become CSS integer tokens.
      style({ gridColumnEnd: 'span 1e0 content' })
    })

    test('rejects wrong compound domains through fallbacks and importance', () => {
      // @ts-expect-error Shadows require dimensions or colors.
      style({ boxShadow: 'wobbly' })
      // @ts-expect-error Font feature settings require quoted tags.
      style({ fontFeatureSettings: 'kern' })
      // @ts-expect-error Filters require a recognized function or URL.
      style({ filter: 'red !important' })
      // @ts-expect-error Path data requires a path function.
      style({ d: 'M0 0L20 20' })
      // @ts-expect-error Quotation strings are paired.
      style({ quotes: '"one"' })
      // @ts-expect-error Shape declarations do not accept arbitrary numbers.
      style({ clipPath: 12 })
      // @ts-expect-error Importance retains filter constraints inside fallbacks.
      style({ backdropFilter: ['blur(2px)', 'wobbly !important'] })
      // @ts-expect-error Path lengths exclude percentages.
      style({ pathLength: '50%' })
    })
  })
})

describe('conditions', () => {
  describe('style', () => {
    test('requires parenthesized support conditions', () => {
      // @ts-expect-error Support conditions require parentheses or a feature function.
      style({ '@supports display: grid': { color: 'red' } })
      style({ '@supports selector(:has(*))': { color: 'red' } })
    })
    test('accepts case-insensitive media types', () => {
      style({
        '@media SCREEN': { color: 'red' },
        '@media OnLy ScReEn': { color: 'blue' },
      })
    })
  })

  describe('define', () => {
    test('preserves broad bound declarations and rejects unknown keys', () => {
      const theme: Theme.Definition = Theme.define({
        breakpoint: { tablet: '48rem' },
        color: { accent: 'red' },
      })
      const styles = {} as Style.Properties<Theme.Tokens>

      Style.define({ styles }, { vars: theme })

      const declarations = {} as Style.DeclarationProperties & {
        widht?: string
      }

      // @ts-expect-error Broad declaration annotations must retain exact keys too.
      Style.define({ declarations })
    })
  })
})

describe('validation', () => {
  describe('define', () => {
    test('checks hex digits and lengths through fallbacks and importance', () => {
      Style.define({
        card: { color: ['#AbC', '#abcd', '#123456', '#12345678 !important'] },
      })
      style({ color: '#abc !important' })
      // @ts-expect-error Hex colors require 3, 4, 6, or 8 digits.
      style({ color: '#12' })
      // @ts-expect-error Hex colors cannot contain non-hex digits.
      Style.define({ card: { color: '#12g456' } })
      // @ts-expect-error Importance retains hex constraints.
      style({ color: ['red', '#12345 !important'] })
      // @ts-expect-error Hex colors cannot exceed eight digits.
      style({ color: '#123456789' })
    })

    test('checks integer and nonnegative literals without restricting clamped alpha', () => {
      style({ opacity: -1, order: -2, padding: 0, transitionDelay: '-1s' })
      style({ padding: '-0px', transitionDuration: '-0s' })
      // @ts-expect-error Percentages preserve nonnegative property bounds.
      style({ fontWidth: '-1%' })
      // @ts-expect-error Order is an integer.
      style({ order: 0.5 })
      // @ts-expect-error Importance retains integer constraints.
      style({ order: '1.5 !important' })
      // @ts-expect-error Padding does not accept a negative literal.
      Style.define({ card: { padding: '-1px' } })
      // @ts-expect-error Duration does not accept a negative literal.
      style({ animationDuration: ['1s', '-1s !important'] })
      // @ts-expect-error Flex growth is nonnegative.
      style({ flexGrow: -1 })
      // @ts-expect-error Column count is positive.
      style({ columnCount: 0 })
    })
  })

  describe('define theme', () => {
    test('preserves named tokens and validates concrete token colors', () => {
      const theme = Theme.define({
        color: { brand: '#123456' },
        spacing: { 4: '1rem' },
      })

      theme.style({ color: 'brand', padding: 4 })
      // @ts-expect-error Concrete theme colors retain hex constraints.
      Theme.define({ color: { brand: '#12345' } })
      // @ts-expect-error Bound authoring retains integer constraints.
      theme.style({ order: 0.5 })
      // @ts-expect-error Explicit color tokens cannot be used as spacing.
      Style.define({ card: { padding: theme.tokens.color.brand } })
    })
  })

  describe('image declarations', () => {
    test('types image functions, URL-only markers, and fallback importance', () => {
      style({
        backgroundImage: [
          'url("image.png")',
          'linear-gradient(red, blue) !important',
        ],
        markerEnd: 'url(#arrow)',
        maskImage: 'none, url(#mask)',
      })
      // @ts-expect-error Markers require a URL or none.
      style({ marker: 'linear-gradient(red, blue)' })
      // @ts-expect-error Image values cannot be a bare color.
      style({ backgroundImage: 'red' })
      // @ts-expect-error Image sources do not accept numeric lengths.
      Style.define({ card: { borderImageSource: 4 } })
    })
  })
})
