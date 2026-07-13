/**
 * ResourceMentionInput — TextInput with @-mention autocomplete for resources.
 *
 * Usage
 * -----
 *   <ResourceMentionInput
 *     value={text}
 *     onChangeText={setText}
 *     onSubmit={handleSend}
 *     placeholder="Message..."
 *   />
 *
 * Mention token format
 * --------------------
 * When the user selects a resource from the dropdown, the current @-trigger
 * word (e.g. "@food") is replaced with a structured token:
 *
 *   @[Resource Name](resource:uuid)
 *
 * The surrounding text is preserved verbatim. Token parsing/rendering for
 * display purposes lives in ResourceMentionText.tsx.
 *
 * Trigger behaviour
 * -----------------
 * - The component watches for `@` followed by a non-space run of characters.
 * - A search is fired after the user types ≥1 character following `@`.
 * - Typing a space after `@...` or pressing Escape dismisses the dropdown.
 * - Selecting from the dropdown inserts the token and fires a debounced search
 *   clear so the dropdown closes immediately.
 * - Results are limited to 6 to keep the dropdown compact on small screens.
 *
 * Platform notes
 * --------------
 * The dropdown uses absolute positioning. On web the position is relative to
 * the nearest positioned ancestor (the wrapping View). On mobile the same
 * approach works because the input sits inside a stable parent container.
 * If you embed this inside a ScrollView you may need to set
 * `keyboardShouldPersistTaps="handled"` on the ScrollView.
 *
 * Accessibility
 * -------------
 * The dropdown items are `accessibilityRole="button"` with a descriptive
 * accessibilityLabel. The trigger character `@` is announced via
 * accessibilityHint on the TextInput.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
} from 'react-native';
import { Phone, MapPin } from 'lucide-react-native';

import { searchResources, type Resource } from '../../api/resources';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Regex to find the last @-trigger in the cursor's vicinity. */
const MENTION_TRIGGER_REGEX = /@([^\s@]*)$/;

/** Minimum chars after @ before we start querying. */
const MIN_QUERY_LENGTH = 1;

/** Debounce delay (ms) before firing the search after the user stops typing. */
const SEARCH_DEBOUNCE_MS = 250;

/** Maximum results shown in the dropdown. */
const MAX_DROPDOWN_RESULTS = 6;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ResourceMentionInputProps
  extends Omit<TextInputProps, 'value' | 'onChangeText'> {
  /** Controlled text value. */
  value: string;
  /** Called when the text changes (may include mention tokens). */
  onChangeText: (text: string) => void;
  /**
   * Called when the user submits (taps send / hits return).
   * If not provided, the default TextInput submit behaviour applies.
   */
  onSubmit?: () => void;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export const ResourceMentionInput = forwardRef<
  TextInput,
  ResourceMentionInputProps
>(function ResourceMentionInput(
  { value, onChangeText, onSubmit, style, ...rest },
  ref,
) {
  // ── State ───────────────────────────────────────────────────────────────────

  /**
   * The query string extracted after the last @ trigger, or null when the
   * dropdown is closed.
   */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [dropdownResults, setDropdownResults] = useState<Resource[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  /** Start position of the current @-trigger in the text (for replacement). */
  const triggerStartRef = useRef<number | null>(null);

  /** Debounce timer for search calls. */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Text change handler ─────────────────────────────────────────────────────

  const handleChangeText = useCallback(
    (newText: string) => {
      onChangeText(newText);

      // Detect @-mention trigger at the end of the current cursor position.
      // We scan the text up to the cursor; since we don't have a cursor
      // position API on all platforms, we match the last @ trigger in the text.
      const match = MENTION_TRIGGER_REGEX.exec(newText);
      if (!match) {
        setMentionQuery(null);
        setDropdownResults([]);
        return;
      }

      const query = match[1]; // text after @
      const triggerStart = match.index; // position of @ in the string

      if (query.length < MIN_QUERY_LENGTH) {
        // @ typed but no query chars yet — keep dropdown closed.
        setMentionQuery(null);
        setDropdownResults([]);
        return;
      }

      triggerStartRef.current = triggerStart;
      setMentionQuery(query);

      // Debounce the search.
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        setIsSearching(true);
        try {
          const results = await searchResources({
            q: query,
            limit: MAX_DROPDOWN_RESULTS,
          });
          setDropdownResults(results);
        } catch {
          // Silent failure — dropdown stays empty on network error.
          setDropdownResults([]);
        } finally {
          setIsSearching(false);
        }
      }, SEARCH_DEBOUNCE_MS);
    },
    [onChangeText],
  );

  // Cleanup debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Selection handler ───────────────────────────────────────────────────────

  const handleSelectResource = useCallback(
    (resource: Resource) => {
      const triggerStart = triggerStartRef.current;
      if (triggerStart === null) return;

      // The token replaces from the @ character to the end of the @-word.
      const match = MENTION_TRIGGER_REGEX.exec(value);
      if (!match) return;

      const beforeTrigger = value.slice(0, triggerStart);
      const afterTrigger = value.slice(triggerStart + match[0].length);

      // Insert the token with a trailing space for comfortable continued typing.
      const token = `@[${resource.name}](resource:${resource.id})`;
      const newText = `${beforeTrigger}${token} ${afterTrigger}`;

      onChangeText(newText);
      setMentionQuery(null);
      setDropdownResults([]);
      triggerStartRef.current = null;
      Keyboard.dismiss();
    },
    [value, onChangeText],
  );

  // ── Dismiss dropdown when user types space after trigger ────────────────────

  const dismissDropdown = useCallback(() => {
    setMentionQuery(null);
    setDropdownResults([]);
    triggerStartRef.current = null;
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  const showDropdown =
    mentionQuery !== null && (isSearching || dropdownResults.length > 0);

  return (
    <View style={styles.container}>
      {/* Dropdown positioned ABOVE the input (typical chat pattern) */}
      {showDropdown && (
        <View
          style={[
            styles.dropdown,
            Platform.OS === 'web' ? styles.dropdownWeb : styles.dropdownNative,
          ]}
          accessibilityRole="list"
          accessibilityLabel="Resource mention suggestions"
        >
          {isSearching ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.loadingText}>Searching resources…</Text>
            </View>
          ) : (
            <FlatList
              data={dropdownResults}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.dropdownItem}
                  onPress={() => handleSelectResource(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Mention ${item.name}${item.phone ? `, phone ${item.phone}` : ''}`}
                  activeOpacity={0.7}
                >
                  <View style={styles.dropdownItemContent}>
                    <Text style={styles.resourceName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <View style={styles.resourceMeta}>
                      {item.phone ? (
                        <View style={styles.metaRow}>
                          <Phone size={11} color={colors.mutedForeground} />
                          <Text style={styles.metaText}>{item.phone}</Text>
                        </View>
                      ) : null}
                      {item.address ? (
                        <View style={styles.metaRow}>
                          <MapPin size={11} color={colors.mutedForeground} />
                          <Text style={styles.metaText} numberOfLines={1}>
                            {item.address}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <View
                      style={[
                        styles.categoryBadge,
                        { backgroundColor: _categoryColor(item.category) + '20' },
                      ]}
                    >
                      <Text
                        style={[
                          styles.categoryLabel,
                          { color: _categoryColor(item.category) },
                        ]}
                      >
                        {_categoryLabel(item.category)}
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>
              )}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
            />
          )}
        </View>
      )}

      <TextInput
        ref={ref}
        value={value}
        onChangeText={handleChangeText}
        onSubmitEditing={onSubmit ? () => onSubmit() : undefined}
        accessibilityHint="Type @ to mention a community resource"
        style={[styles.input, style]}
        {...rest}
      />
    </View>
  );
});

// ─── Category display helpers ──────────────────────────────────────────────────

// Epic C5: 'housing' is grandfathered — kept so an @-mentioned resource still
// categorized 'housing' renders its correct colour/label. 'utilities' is its
// replacement. This is a read-only rendering map (no picker here).
const _CATEGORY_COLORS: Record<string, string> = {
  housing: '#3B82F6',
  utilities: '#F97316',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  rehab: '#EF4444',
  healthcare: '#06B6D4',
  legal: '#10B981',
  transportation: '#F97316',
  other: '#6B7280',
};

const _CATEGORY_LABELS: Record<string, string> = {
  housing: 'Housing',
  utilities: 'Utilities',
  food: 'Food',
  mental_health: 'Mental Health',
  rehab: 'Rehab',
  healthcare: 'Healthcare',
  legal: 'Legal',
  transportation: 'Transportation',
  other: 'Other',
};

function _categoryColor(category: string): string {
  return _CATEGORY_COLORS[category] ?? '#6B7280';
}

function _categoryLabel(category: string): string {
  return _CATEGORY_LABELS[category] ?? category;
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  dropdown: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: 260,
    zIndex: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 8,
  },
  // On native: position above the input.
  dropdownNative: {
    bottom: '100%',
    marginBottom: 4,
  },
  // On web: also above the input, but use CSS-compatible positioning.
  dropdownWeb: {
    bottom: '100%',
    marginBottom: 4,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 8,
  },
  loadingText: {
    ...typography.bodySm,
    fontSize: 13,
    color: colors.mutedForeground,
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dropdownItemContent: {
    gap: 4,
  },
  resourceName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.foreground,
  },
  resourceMeta: {
    gap: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 11,
    color: colors.mutedForeground,
    flex: 1,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 2,
  },
  categoryLabel: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: 12,
  },
  input: {
    // Intentionally unstyled — callers supply their own input style.
  },
});
