/**
 * AdminResourcesScreen — admin management UI for the CHW Resource Folder.
 *
 * Sections (tab-based):
 *   "Catalog"     — paginated list of all resources with create/edit/soft-delete
 *   "Suggestions" — pending CHW suggestion queue with approve/reject actions
 *
 * Auth: This screen is reachable only from AdminHomeScreen, which is only
 * rendered when the authenticated user has role="admin". The backend endpoints
 * accept the ADMIN_KEY bearer token; in this native admin screen we pass the
 * user JWT and rely on the backend's `require_admin_key` dependency. If the
 * project later restricts native admin screens to ADMIN_KEY-only, replace
 * the `api()` calls in resources.ts with an explicit header override.
 *
 * Data fetching: React Query (useQuery / useMutation) via the hooks returned
 * from the api/resources module. We don't define separate hook files here
 * because the Admin screen is self-contained and the pattern is already
 * established for all other admin functionality (AdminHomeScreen doesn't have
 * its own hooks file either — it calls api() inline).
 *
 * State machine:
 *   - catalogTab: list view | create form | edit form (one resource)
 *   - suggestionsTab: list view | review view (one suggestion)
 *
 * No routing library needed here: the screen is a self-contained modal-style
 * sheet with internal navigation state.
 */

import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check, ChevronLeft, Edit2, Plus, Trash2, X } from 'lucide-react-native';

import {
  adminApproveSuggestion,
  adminCreateResource,
  adminDeleteResource,
  adminListResources,
  adminListSuggestions,
  adminRejectSuggestion,
  adminUpdateResource,
  type Resource,
  type ResourceCategory,
  type ResourceCreatePayload,
  type ResourceSuggestion,
  type ResourceUpdatePayload,
} from '../../api/resources';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Constants ─────────────────────────────────────────────────────────────────

// Epic C5: 'housing' is intentionally excluded — grandfathered, not newly
// selectable. A resource whose saved category is still 'housing' keeps
// rendering correctly (Resource.category is typed to admit it, and the
// backend keeps validating it — see schemas/resource.py) but this picker,
// used by BOTH the create and edit forms, must never offer it again so an
// admin can't re-tag a resource back into Housing. 'utilities' replaces it.
const CATEGORIES: Array<{ key: ResourceCategory; label: string }> = [
  { key: 'utilities', label: 'Utilities' },
  { key: 'food', label: 'Food' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab' },
  { key: 'healthcare', label: 'Healthcare' },
  { key: 'legal', label: 'Legal' },
  { key: 'transportation', label: 'Transportation' },
  { key: 'other', label: 'Other' },
];

// Grandfathered display labels for categories no longer offered by
// CATEGORIES above, so a legacy resource still shows a proper capitalized
// label ("Housing") in the catalog list rather than falling back to the raw
// lowercase wire value.
const GRANDFATHERED_CATEGORY_LABELS: Partial<Record<ResourceCategory, string>> = {
  housing: 'Housing',
};

function categoryLabel(category: ResourceCategory): string {
  return (
    CATEGORIES.find((c) => c.key === category)?.label ??
    GRANDFATHERED_CATEGORY_LABELS[category] ??
    category
  );
}

// ─── Types ─────────────────────────────────────────────────────────────────────

type ActiveTab = 'catalog' | 'suggestions';
type CatalogView = 'list' | 'create' | { kind: 'edit'; resource: Resource };
type SuggestionsView = 'list' | { kind: 'review'; suggestion: ResourceSuggestion };

interface FormState {
  name: string;
  description: string;
  category: ResourceCategory;
  phone: string;
  url: string;
  address: string;
  zipCode: string;
  hours: string;
  eligibility: string;
  languages: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  category: 'other',
  phone: '',
  url: '',
  address: '',
  zipCode: '',
  hours: '',
  eligibility: '',
  languages: '',
};

function resourceToForm(r: Resource): FormState {
  return {
    name: r.name,
    description: r.description,
    category: r.category,
    phone: r.phone ?? '',
    url: r.url ?? '',
    address: r.address ?? '',
    zipCode: r.zipCode ?? '',
    hours: r.hours ?? '',
    eligibility: r.eligibility ?? '',
    languages: r.languages.join(', '),
  };
}

function formToCreatePayload(form: FormState): ResourceCreatePayload {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category,
    phone: form.phone.trim() || null,
    url: form.url.trim() || null,
    address: form.address.trim() || null,
    zipCode: form.zipCode.trim() || null,
    hours: form.hours.trim() || null,
    eligibility: form.eligibility.trim() || null,
    languages: form.languages
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

function formToUpdatePayload(form: FormState): ResourceUpdatePayload {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    category: form.category,
    phone: form.phone.trim() || null,
    url: form.url.trim() || null,
    address: form.address.trim() || null,
    zipCode: form.zipCode.trim() || null,
    hours: form.hours.trim() || null,
    eligibility: form.eligibility.trim() || null,
    languages: form.languages
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  };
}

// ─── Sub-components ────────────────────────────────────────────────────────────

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  required = false,
}: FieldProps): React.JSX.Element {
  return (
    <View style={fs.fieldWrapper}>
      <Text style={fs.label}>
        {label}
        {required ? <Text style={fs.required}> *</Text> : null}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        multiline={multiline}
        numberOfLines={multiline ? 3 : 1}
        style={[fs.input, multiline && fs.inputMultiline]}
      />
    </View>
  );
}

interface CategoryPickerProps {
  value: ResourceCategory;
  onChange: (v: ResourceCategory) => void;
}

function CategoryPicker({ value, onChange }: CategoryPickerProps): React.JSX.Element {
  return (
    <View style={fs.fieldWrapper}>
      <Text style={fs.label}>
        Category<Text style={fs.required}> *</Text>
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={fs.categoryRow}
      >
        {CATEGORIES.map((cat) => (
          <TouchableOpacity
            key={cat.key}
            style={[
              fs.categoryChip,
              value === cat.key && fs.categoryChipSelected,
            ]}
            onPress={() => onChange(cat.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === cat.key }}
            accessibilityLabel={cat.label}
          >
            <Text
              style={[
                fs.categoryChipLabel,
                value === cat.key && fs.categoryChipLabelSelected,
              ]}
            >
              {cat.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Resource Form ─────────────────────────────────────────────────────────────

interface ResourceFormProps {
  initialForm: FormState;
  title: string;
  submitLabel: string;
  onSubmit: (form: FormState) => Promise<void>;
  onCancel: () => void;
}

function ResourceForm({
  initialForm,
  title,
  submitLabel,
  onSubmit,
  onCancel,
}: ResourceFormProps): React.JSX.Element {
  const [form, setForm] = useState<FormState>(initialForm);
  const [isSaving, setIsSaving] = useState(false);

  const set = useCallback(
    (key: keyof FormState) => (value: string) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    if (!form.name.trim() || !form.description.trim()) {
      Alert.alert('Validation', 'Name and description are required.');
      return;
    }
    setIsSaving(true);
    try {
      await onSubmit(form);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      Alert.alert('Error', message);
    } finally {
      setIsSaving(false);
    }
  }, [form, onSubmit]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
    >
      <View style={fs.formHeader}>
        <TouchableOpacity onPress={onCancel} style={fs.backButton}>
          <ChevronLeft size={20} color={colors.primary} />
          <Text style={fs.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={fs.formTitle}>{title}</Text>
      </View>
      <ScrollView style={fs.formBody} contentContainerStyle={fs.formContent}>
        <Field
          label="Name"
          value={form.name}
          onChange={set('name')}
          placeholder="e.g. South LA Food Pantry"
          required
        />
        <Field
          label="Description"
          value={form.description}
          onChange={set('description')}
          placeholder="Brief description of services offered…"
          multiline
          required
        />
        <CategoryPicker
          value={form.category}
          onChange={(v) => setForm((prev) => ({ ...prev, category: v }))}
        />
        <Field
          label="Phone"
          value={form.phone}
          onChange={set('phone')}
          placeholder="(310) 555-0100"
        />
        <Field
          label="Website URL"
          value={form.url}
          onChange={set('url')}
          placeholder="https://example.org"
        />
        <Field
          label="Address"
          value={form.address}
          onChange={set('address')}
          placeholder="1234 Vermont Ave, Los Angeles, CA 90044"
        />
        <Field
          label="Zip Code"
          value={form.zipCode}
          onChange={set('zipCode')}
          placeholder="90001"
        />
        <Field
          label="Hours"
          value={form.hours}
          onChange={set('hours')}
          placeholder="Mon–Fri 9 AM–5 PM"
          multiline
        />
        <Field
          label="Eligibility"
          value={form.eligibility}
          onChange={set('eligibility')}
          placeholder="Who is this for?"
          multiline
        />
        <Field
          label="Languages (comma-separated)"
          value={form.languages}
          onChange={set('languages')}
          placeholder="English, Spanish"
        />
      </ScrollView>
      <View style={fs.formActions}>
        <TouchableOpacity
          style={fs.cancelBtn}
          onPress={onCancel}
          accessibilityRole="button"
        >
          <Text style={fs.cancelLabel}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[fs.saveBtn, isSaving && fs.saveBtnDisabled]}
          onPress={handleSubmit}
          disabled={isSaving}
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={fs.saveLabel}>{submitLabel}</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────────

export function AdminResourcesScreen(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ActiveTab>('catalog');

  // ── Catalog state ──────────────────────────────────────────────────────────
  const [catalogView, setCatalogView] = useState<CatalogView>('list');
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourcesTotal, setResourcesTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogFilter, setCatalogFilter] = useState('');

  // ── Suggestions state ──────────────────────────────────────────────────────
  const [suggestionsView, setSuggestionsView] = useState<SuggestionsView>('list');
  const [suggestions, setSuggestions] = useState<ResourceSuggestion[]>([]);
  const [suggestionsTotal, setSuggestionsTotal] = useState(0);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  // ── Catalog fetch ──────────────────────────────────────────────────────────
  const fetchResources = useCallback(
    async (page = 1, q = '') => {
      setCatalogLoading(true);
      try {
        const result = await adminListResources({ page, pageSize: 20, q: q || undefined });
        setResources(result.items);
        setResourcesTotal(result.total);
        setCatalogPage(page);
      } catch (err: unknown) {
        Alert.alert('Error', err instanceof Error ? err.message : 'Load failed');
      } finally {
        setCatalogLoading(false);
      }
    },
    [],
  );

  // ── Suggestions fetch ──────────────────────────────────────────────────────
  const fetchSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const result = await adminListSuggestions('pending');
      setSuggestions(result.items);
      setSuggestionsTotal(result.total);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Load failed');
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  // Initial loads.
  useEffect(() => {
    void fetchResources(1, '');
  }, [fetchResources]);

  useEffect(() => {
    void fetchSuggestions();
  }, [fetchSuggestions]);

  // ── Catalog actions ────────────────────────────────────────────────────────

  const handleCreateResource = useCallback(
    async (form: FormState) => {
      await adminCreateResource(formToCreatePayload(form));
      setCatalogView('list');
      void fetchResources(1, catalogFilter);
    },
    [catalogFilter, fetchResources],
  );

  const handleUpdateResource = useCallback(
    async (resourceId: string, form: FormState) => {
      await adminUpdateResource(resourceId, formToUpdatePayload(form));
      setCatalogView('list');
      void fetchResources(catalogPage, catalogFilter);
    },
    [catalogPage, catalogFilter, fetchResources],
  );

  const handleSoftDelete = useCallback(
    (resource: Resource) => {
      Alert.alert(
        'Deactivate resource?',
        `"${resource.name}" will be marked inactive. Existing @-mentions will still resolve.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Deactivate',
            style: 'destructive',
            onPress: async () => {
              try {
                await adminDeleteResource(resource.id);
                void fetchResources(catalogPage, catalogFilter);
              } catch (err: unknown) {
                Alert.alert('Error', err instanceof Error ? err.message : 'Delete failed');
              }
            },
          },
        ],
      );
    },
    [catalogPage, catalogFilter, fetchResources],
  );

  // ── Suggestion actions ─────────────────────────────────────────────────────

  const handleApproveSuggestion = useCallback(
    async (suggestion: ResourceSuggestion) => {
      try {
        await adminApproveSuggestion(suggestion.id, {});
        void fetchSuggestions();
        void fetchResources(1, '');
        setSuggestionsView('list');
      } catch (err: unknown) {
        Alert.alert('Error', err instanceof Error ? err.message : 'Approve failed');
      }
    },
    [fetchSuggestions, fetchResources],
  );

  const handleRejectSuggestion = useCallback(
    (suggestion: ResourceSuggestion) => {
      // Alert.prompt is iOS-only. Use a simple confirm Alert cross-platform;
      // admin can add notes from the full review view before rejecting.
      Alert.alert(
        'Reject suggestion',
        `Reject "${String(suggestion.proposedResource['name'] ?? 'this suggestion')}"? This cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Reject',
            style: 'destructive',
            onPress: async () => {
              try {
                await adminRejectSuggestion(suggestion.id);
                void fetchSuggestions();
                setSuggestionsView('list');
              } catch (err: unknown) {
                Alert.alert('Error', err instanceof Error ? err.message : 'Reject failed');
              }
            },
          },
        ],
      );
    },
    [fetchSuggestions],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>Resource Folder</Text>
      </View>

      {/* Tab bar */}
      <View style={s.tabBar}>
        <TouchableOpacity
          style={[s.tab, activeTab === 'catalog' && s.tabActive]}
          onPress={() => setActiveTab('catalog')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'catalog' }}
        >
          <Text style={[s.tabLabel, activeTab === 'catalog' && s.tabLabelActive]}>
            Catalog ({resourcesTotal})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, activeTab === 'suggestions' && s.tabActive]}
          onPress={() => setActiveTab('suggestions')}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'suggestions' }}
        >
          <Text style={[s.tabLabel, activeTab === 'suggestions' && s.tabLabelActive]}>
            Suggestions{suggestionsTotal > 0 ? ` (${suggestionsTotal})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Catalog tab ─────────────────────────────────────────────────── */}
      {activeTab === 'catalog' && catalogView === 'list' && (
        <View style={s.content}>
          {/* Search + Add */}
          <View style={s.toolbar}>
            <TextInput
              style={s.searchInput}
              placeholder="Search resources…"
              placeholderTextColor={colors.mutedForeground}
              value={catalogFilter}
              onChangeText={(v) => {
                setCatalogFilter(v);
                void fetchResources(1, v);
              }}
              returnKeyType="search"
            />
            <TouchableOpacity
              style={s.addButton}
              onPress={() => setCatalogView('create')}
              accessibilityRole="button"
              accessibilityLabel="Add new resource"
            >
              <Plus size={20} color="#fff" />
            </TouchableOpacity>
          </View>

          {catalogLoading ? (
            <ActivityIndicator style={s.loader} color={colors.primary} />
          ) : (
            <ScrollView contentContainerStyle={s.listContent}>
              {resources.map((resource) => (
                <View key={resource.id} style={s.resourceCard}>
                  <View style={s.resourceInfo}>
                    <View style={s.resourceNameRow}>
                      <Text style={s.resourceName} numberOfLines={1}>
                        {resource.name}
                      </Text>
                      {resource.status === 'inactive' && (
                        <View style={s.inactiveBadge}>
                          <Text style={s.inactiveBadgeLabel}>Inactive</Text>
                        </View>
                      )}
                    </View>
                    <Text style={s.resourceCategory}>
                      {categoryLabel(resource.category)}
                    </Text>
                    {resource.phone ? (
                      <Text style={s.resourcePhone}>{resource.phone}</Text>
                    ) : null}
                  </View>
                  <View style={s.resourceActions}>
                    <TouchableOpacity
                      style={s.actionBtn}
                      onPress={() => setCatalogView({ kind: 'edit', resource })}
                      accessibilityRole="button"
                      accessibilityLabel={`Edit ${resource.name}`}
                    >
                      <Edit2 size={16} color={colors.primary} />
                    </TouchableOpacity>
                    {resource.status === 'active' && (
                      <TouchableOpacity
                        style={[s.actionBtn, s.actionBtnDestructive]}
                        onPress={() => handleSoftDelete(resource)}
                        accessibilityRole="button"
                        accessibilityLabel={`Deactivate ${resource.name}`}
                      >
                        <Trash2 size={16} color={colors.destructive} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              ))}
              {resources.length === 0 && !catalogLoading && (
                <Text style={s.emptyLabel}>No resources found.</Text>
              )}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── Create form ─────────────────────────────────────────────────── */}
      {activeTab === 'catalog' && catalogView === 'create' && (
        <ResourceForm
          initialForm={EMPTY_FORM}
          title="Add Resource"
          submitLabel="Create"
          onSubmit={handleCreateResource}
          onCancel={() => setCatalogView('list')}
        />
      )}

      {/* ── Edit form ───────────────────────────────────────────────────── */}
      {activeTab === 'catalog' &&
        typeof catalogView === 'object' &&
        catalogView.kind === 'edit' && (
          <ResourceForm
            initialForm={resourceToForm(catalogView.resource)}
            title="Edit Resource"
            submitLabel="Save"
            onSubmit={(form) => handleUpdateResource(catalogView.resource.id, form)}
            onCancel={() => setCatalogView('list')}
          />
        )}

      {/* ── Suggestions list ─────────────────────────────────────────────── */}
      {activeTab === 'suggestions' && suggestionsView === 'list' && (
        <View style={s.content}>
          {suggestionsLoading ? (
            <ActivityIndicator style={s.loader} color={colors.primary} />
          ) : (
            <ScrollView contentContainerStyle={s.listContent}>
              {suggestions.map((suggestion) => (
                <TouchableOpacity
                  key={suggestion.id}
                  style={s.suggestionCard}
                  onPress={() => setSuggestionsView({ kind: 'review', suggestion })}
                  accessibilityRole="button"
                  accessibilityLabel={`Review suggestion: ${String(suggestion.proposedResource['name'] ?? 'unnamed')}`}
                >
                  <View style={s.suggestionInfo}>
                    <Text style={s.suggestionName} numberOfLines={1}>
                      {String(suggestion.proposedResource['name'] ?? 'Unnamed')}
                    </Text>
                    {suggestion.notes ? (
                      <Text style={s.suggestionNotes} numberOfLines={2}>
                        {suggestion.notes}
                      </Text>
                    ) : null}
                    <Text style={s.suggestionMeta}>
                      Submitted {new Date(suggestion.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={s.suggestionQuickActions}>
                    <TouchableOpacity
                      style={s.approveBtn}
                      onPress={() => { void handleApproveSuggestion(suggestion); }}
                      accessibilityRole="button"
                      accessibilityLabel="Approve suggestion"
                    >
                      <Check size={16} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.rejectBtn}
                      onPress={() => { handleRejectSuggestion(suggestion); }}
                      accessibilityRole="button"
                      accessibilityLabel="Reject suggestion"
                    >
                      <X size={16} color="#fff" />
                    </TouchableOpacity>
                  </View>
                </TouchableOpacity>
              ))}
              {suggestions.length === 0 && !suggestionsLoading && (
                <Text style={s.emptyLabel}>No pending suggestions.</Text>
              )}
            </ScrollView>
          )}
        </View>
      )}

      {/* ── Suggestion review ────────────────────────────────────────────── */}
      {activeTab === 'suggestions' &&
        typeof suggestionsView === 'object' &&
        suggestionsView.kind === 'review' && (
          <View style={s.content}>
            <TouchableOpacity
              style={s.backRow}
              onPress={() => setSuggestionsView('list')}
              accessibilityRole="button"
            >
              <ChevronLeft size={20} color={colors.primary} />
              <Text style={s.backLabel2}>Back to queue</Text>
            </TouchableOpacity>
            <ScrollView contentContainerStyle={s.reviewContent}>
              <Text style={s.reviewTitle}>
                {String(suggestionsView.suggestion.proposedResource['name'] ?? 'Unnamed')}
              </Text>
              <Text style={s.reviewMeta}>
                Submitted {new Date(suggestionsView.suggestion.createdAt).toLocaleDateString()}
              </Text>
              {suggestionsView.suggestion.notes ? (
                <View style={s.reviewSection}>
                  <Text style={s.reviewSectionTitle}>CHW Notes</Text>
                  <Text style={s.reviewBody}>{suggestionsView.suggestion.notes}</Text>
                </View>
              ) : null}
              <View style={s.reviewSection}>
                <Text style={s.reviewSectionTitle}>Proposed Data</Text>
                {Object.entries(suggestionsView.suggestion.proposedResource).map(([k, v]) => (
                  <Text key={k} style={s.reviewBody}>
                    <Text style={s.reviewKey}>{k}: </Text>
                    {String(v)}
                  </Text>
                ))}
              </View>
            </ScrollView>
            <View style={s.reviewActions}>
              <TouchableOpacity
                style={s.rejectBtnLg}
                onPress={() => handleRejectSuggestion(suggestionsView.suggestion)}
                accessibilityRole="button"
              >
                <Text style={s.rejectLabel}>Reject</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.approveBtnLg}
                onPress={() => void handleApproveSuggestion(suggestionsView.suggestion)}
                accessibilityRole="button"
              >
                <Text style={s.approveLabel}>Approve & Add to Catalog</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    ...typography.displaySm,
    color: colors.foreground,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabLabel: {
    ...typography.bodySm,
    color: colors.mutedForeground,
  },
  tabLabelActive: {
    color: colors.primary,
    fontWeight: '700',
  },
  content: {
    flex: 1,
  },
  toolbar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1,
    height: 40,
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    ...typography.bodySm,
    color: colors.foreground,
  },
  addButton: {
    width: 40,
    height: 40,
    backgroundColor: colors.primary,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loader: {
    marginTop: 40,
  },
  listContent: {
    padding: 16,
    gap: 10,
  },
  resourceCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  resourceInfo: {
    flex: 1,
    gap: 4,
  },
  resourceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  resourceName: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
    flex: 1,
  },
  inactiveBadge: {
    backgroundColor: colors.muted,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  inactiveBadgeLabel: {
    fontSize: 10,
    color: colors.mutedForeground,
    fontWeight: '600',
  },
  resourceCategory: {
    ...typography.label,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  resourcePhone: {
    ...typography.bodySm,
    color: colors.mutedForeground,
  },
  resourceActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnDestructive: {
    backgroundColor: colors.destructive + '15',
  },
  emptyLabel: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginTop: 40,
  },
  suggestionCard: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  suggestionInfo: {
    flex: 1,
    gap: 4,
  },
  suggestionName: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
  },
  suggestionNotes: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  suggestionMeta: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  suggestionQuickActions: {
    flexDirection: 'row',
    gap: 8,
  },
  approveBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 4,
  },
  backLabel2: {
    ...typography.bodySm,
    color: colors.primary,
    fontWeight: '600',
  },
  reviewContent: {
    padding: 20,
    gap: 16,
  },
  reviewTitle: {
    ...typography.displaySm,
    color: colors.foreground,
  },
  reviewMeta: {
    ...typography.bodySm,
    color: colors.mutedForeground,
  },
  reviewSection: {
    gap: 6,
  },
  reviewSectionTitle: {
    ...typography.label,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  reviewBody: {
    ...typography.bodySm,
    color: colors.foreground,
    lineHeight: 20,
  },
  reviewKey: {
    fontWeight: '700',
  },
  reviewActions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rejectBtnLg: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectLabel: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.destructive,
  },
  approveBtnLg: {
    flex: 2,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveLabel: {
    ...typography.bodySm,
    fontWeight: '700',
    color: '#fff',
  },
});

const fs = StyleSheet.create({
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  backLabel: {
    ...typography.bodySm,
    color: colors.primary,
    fontWeight: '600',
  },
  formTitle: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
    flex: 1,
  },
  formBody: {
    flex: 1,
  },
  formContent: {
    padding: 16,
    gap: 16,
  },
  fieldWrapper: {
    gap: 6,
  },
  label: {
    ...typography.label,
    color: colors.foreground,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  required: {
    color: colors.destructive,
  },
  input: {
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...typography.bodySm,
    color: colors.foreground,
  },
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  categoryRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
  },
  categoryChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  categoryChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  categoryChipLabel: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  categoryChipLabelSelected: {
    color: '#fff',
  },
  formActions: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelLabel: {
    ...typography.bodySm,
    color: colors.foreground,
    fontWeight: '600',
  },
  saveBtn: {
    flex: 2,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveLabel: {
    ...typography.bodySm,
    color: '#fff',
    fontWeight: '700',
  },
});
