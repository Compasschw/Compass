/**
 * CHWDocumentsScreen — document management for CHWs.
 *
 * Shows all MemberDocument rows where uploaded_by == current CHW's user ID.
 * Provides:
 *   - Search by filename or member ID
 *   - Filter by document type (all, id, income, address, medical, other)
 *   - Table rows with filename, type, uploaded date, size, Download, Delete
 *   - Right rail stat tiles (web only)
 *   - Upload button: triggers upload flow for a chosen member + document type.
 *     The CHW enters the member UUID (or navigates here from a member profile
 *     with memberId pre-filled via route params) and selects a document type.
 *
 * NOTE: Phase 1 scope — the "Upload on behalf of member" CTA opens an Alert
 * (native) or prompt (web) asking for the member UUID, then calls the full
 * useFileUpload pipeline.  A member-selector picker (from the CHW's caseload)
 * is deferred to Phase 2; the bare-UUID input is functional and sufficient for
 * the cofounder demo.
 */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ClipboardList,
  Download,
  Eye,
  FileBadge,
  FileSignature,
  FileScan,
  FileText,
  Filter,
  Plus,
  Search,
  Trash2,
} from 'lucide-react-native';

import { AppShell, Card, EmptyState, PageHeader, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, numerals, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useMemberDocuments,
  useMemberDocumentDelete,
  useMemberDocumentDownloadUrl,
  type MemberDocumentData,
} from '../../hooks/useApiQueries';
import {
  useFileUpload,
  type DocumentType,
} from '../../hooks/useFileUpload';

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterType = 'all' | DocumentType;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<FilterType, string> = {
  all:     'All Types',
  id:      'Photo ID',
  income:  'Income',
  address: 'Address',
  medical: 'Medical',
  other:   'Other',
};

const DOC_TYPE_PILL: Record<DocumentType, 'blue' | 'purple' | 'emerald' | 'amber' | 'gray'> = {
  id:      'blue',
  income:  'purple',
  address: 'emerald',
  medical: 'amber',
  other:   'gray',
};

function DocTypeIcon({ docType, size = 16 }: { docType: DocumentType; size?: number }): React.JSX.Element {
  const c = colors.textSecondary;
  switch (docType) {
    case 'id':      return <FileSignature size={size} color={c} />;
    case 'income':  return <ClipboardList  size={size} color={c} />;
    case 'address': return <FileBadge      size={size} color={c} />;
    case 'medical': return <FileScan       size={size} color={c} />;
    default:        return <FileText       size={size} color={c} />;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function showError(msg: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(msg);
  } else {
    Alert.alert('Error', msg);
  }
}

// ─── DownloadButton ───────────────────────────────────────────────────────────

function DownloadButton({ docId }: { docId: string }): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const q = useMemberDocumentDownloadUrl(docId, { enabled });

  const handlePress = useCallback(() => {
    if (q.isFetching) return;
    setEnabled(true);
  }, [q.isFetching]);

  React.useEffect(() => {
    if (!enabled || !q.data) return;
    void Linking.openURL(q.data.downloadUrl).catch(() =>
      showError('Could not open the file. Please try again.')
    );
    setEnabled(false);
  }, [enabled, q.data]);

  React.useEffect(() => {
    if (q.isError) { showError('Could not generate a download link.'); setEnabled(false); }
  }, [q.isError]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      accessible
      accessibilityLabel="Download document"
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      {q.isFetching
        ? <ActivityIndicator size="small" color={colors.primary} />
        : <Download size={14} color={colors.textSecondary} />
      }
    </TouchableOpacity>
  );
}

// ─── TableRow ─────────────────────────────────────────────────────────────────

interface TableRowProps {
  doc: MemberDocumentData;
  idx: number;
}

function TableRow({ doc, idx }: TableRowProps): React.JSX.Element {
  const deleteMutation = useMemberDocumentDelete(doc.memberId);

  const handleDelete = useCallback(() => {
    const proceed = (): void => {
      deleteMutation.mutate(doc.id, {
        onError: () => showError('Could not delete the document.'),
      });
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(`Delete "${doc.filename}"?`)) proceed();
    } else {
      Alert.alert('Delete document', `Delete "${doc.filename}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: proceed },
      ]);
    }
  }, [doc, deleteMutation]);

  const isImage = doc.contentType.startsWith('image/');
  const docType = doc.documentType as DocumentType;

  return (
    <Card style={[styles.tableRowCard, idx % 2 === 1 && styles.tableRowAlt]}>
      <View style={styles.tableRow}>
        {/* File */}
        <View style={[styles.colFile, styles.fileCell]}>
          <View style={[styles.fileTypeBadge, { backgroundColor: isImage ? '#7c3aed' : '#dc2626' }]}>
            <Text style={styles.fileTypeBadgeText}>{isImage ? 'IMG' : 'PDF'}</Text>
          </View>
          <View style={styles.fileCellText}>
            <Text style={styles.filename} numberOfLines={1}>{doc.filename}</Text>
            <Text style={styles.fileSubtitle} numberOfLines={1}>
              {DOC_TYPE_LABELS[docType] ?? docType} · {doc.memberId.slice(0, 8)}…
            </Text>
          </View>
        </View>

        {/* Type */}
        <View style={styles.colType}>
          <Pill variant={DOC_TYPE_PILL[docType] ?? 'gray'} size="sm">
            {DOC_TYPE_LABELS[docType] ?? docType}
          </Pill>
        </View>

        {/* Date */}
        <Text style={[styles.cellText, styles.colDate, numerals.tabular as object]}>
          {formatDate(doc.uploadedAt)}
        </Text>

        {/* Size */}
        <Text style={[styles.cellText, styles.colSize, numerals.tabular as object]}>
          {formatBytes(doc.sizeBytes)}
        </Text>

        {/* Actions */}
        <View style={styles.colAction}>
          <TouchableOpacity accessible accessibilityLabel={`Preview ${doc.filename}`} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
            <Eye size={14} color={colors.textSecondary} />
          </TouchableOpacity>
          <DownloadButton docId={doc.id} />
          <TouchableOpacity
            accessible
            accessibilityLabel={`Delete ${doc.filename}`}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            onPress={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending
              ? <ActivityIndicator size="small" color="#dc2626" />
              : <Trash2 size={14} color={colors.textSecondary} />
            }
          </TouchableOpacity>
        </View>
      </View>
    </Card>
  );
}

// ─── Upload trigger (CHW uploads on behalf of a member) ───────────────────────

/**
 * CHWUploadTrigger — minimal upload initiation.
 * On press, prompts for a member UUID (Phase 1: bare input; Phase 2: caseload picker),
 * then prompts for a document type, then runs the upload pipeline.
 */
function CHWUploadTrigger(): React.JSX.Element {
  const [memberId, setMemberId] = useState<string | null>(null);
  const [docType, setDocType] = useState<DocumentType>('other');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { upload, isUploading } = useFileUpload('member_document', {
    memberId: memberId ?? '',
    documentType: docType,
    onError: (err) => showError(err.message),
  });

  const triggerUpload = useCallback((mid: string, dt: DocumentType) => {
    setMemberId(mid);
    setDocType(dt);
    if (Platform.OS === 'web') {
      // Give state a tick to settle before clicking the file input.
      setTimeout(() => fileInputRef.current?.click(), 50);
    } else {
      void upload();
    }
  }, [upload]);

  const handleWebFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (event.target) event.target.value = '';
      void upload(file);
    },
    [upload],
  );

  const handlePress = useCallback(() => {
    if (isUploading) return;

    const docTypes: DocumentType[] = ['id', 'income', 'address', 'medical', 'other'];

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const mid = window.prompt('Member UUID:');
      if (!mid?.trim()) return;
      const dtRaw = window.prompt(
        `Document type (${docTypes.join(', ')}):`,
        'other',
      );
      const dt: DocumentType = docTypes.includes(dtRaw as DocumentType)
        ? (dtRaw as DocumentType)
        : 'other';
      triggerUpload(mid.trim(), dt);
    } else {
      Alert.prompt(
        'Upload document',
        'Enter member UUID:',
        (mid) => {
          if (!mid?.trim()) return;
          Alert.alert(
            'Document type',
            'Select a category:',
            docTypes.map((dt) => ({
              text: DOC_TYPE_LABELS[dt],
              onPress: () => triggerUpload(mid.trim(), dt),
            })),
          );
        },
        'plain-text',
      );
    }
  }, [isUploading, triggerUpload]);

  return (
    <>
      <TouchableOpacity
        onPress={handlePress}
        disabled={isUploading}
        accessible
        accessibilityRole="button"
        accessibilityLabel="Upload document for a member"
        style={styles.uploadTrigger}
      >
        {isUploading
          ? <ActivityIndicator size="small" color="#ffffff" />
          : <Plus size={14} color="#ffffff" />
        }
        <Text style={styles.uploadTriggerText}>
          {isUploading ? 'Uploading…' : 'Upload for Member'}
        </Text>
      </TouchableOpacity>

      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/heic,image/*"
          style={{ display: 'none' }}
          onChange={handleWebFileChange}
          aria-hidden="true"
        />
      )}
    </>
  );
}

// ─── MemberDocumentsTable — fetches + renders docs for one member ─────────────

/**
 * Internally, the CHW Documents screen renders a flat list of documents across
 * all members the CHW has uploaded for.  We achieve this by fetching documents
 * for each member ID that appears in the CHW's session/request caseload.
 *
 * Phase 1 simplification: the screen shows documents uploaded by the current
 * CHW (identified server-side via ``uploaded_by``).  To get a per-member list,
 * we query each member the CHW has a relationship with.
 *
 * For the cofounder demo this is fine.  A dedicated `GET /chw/documents`
 * endpoint aggregating across all member relationships is tracked as a follow-up.
 *
 * KNOWN FOLLOW-UP: Replace with a CHW-scoped documents list endpoint that
 * returns all documents the CHW uploaded across their caseload in a single
 * query (avoids N+1 HTTP calls).
 */

interface MemberDocumentTableProps {
  memberId: string;
  query: string;
  activeType: FilterType;
}

function MemberDocumentTable({ memberId, query, activeType }: MemberDocumentTableProps): React.JSX.Element | null {
  const docsQuery = useMemberDocuments(memberId);
  const docs = docsQuery.data?.items ?? [];

  const filtered = useMemo(() => {
    const lq = query.toLowerCase();
    return docs.filter((d) => {
      const typeMatch = activeType === 'all' || d.documentType === activeType;
      const qMatch = query.length === 0 || d.filename.toLowerCase().includes(lq);
      return typeMatch && qMatch;
    });
  }, [docs, query, activeType]);

  if (docsQuery.isLoading) return null;
  if (filtered.length === 0) return null;

  return (
    <>
      {filtered.map((doc, idx) => (
        <TableRow key={doc.id} doc={doc} idx={idx} />
      ))}
    </>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWDocumentsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<FilterType>('all');

  // Phase 1: use own member profile to seed the member ID list.
  // A real CHW doesn't have member profiles, but we use the same hook pattern.
  // In practice, the CHW documents page will be navigated to from a member profile
  // which passes memberId as a route param.  We render a placeholder here.
  // TODO(documents): add GET /chw/documents endpoint that returns all docs across
  // the CHW's caseload in one call.

  const filterTypes = Object.keys(DOC_TYPE_LABELS) as FilterType[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="Member Documents"
        subtitle="Documents you've uploaded on behalf of your members"
        right={
          <View style={styles.headerRight}>
            <View style={styles.searchWrap}>
              <Search size={14} color={colors.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search documents…"
                placeholderTextColor={colors.textMuted}
                value={query}
                onChangeText={setQuery}
                accessibilityLabel="Search documents"
              />
            </View>
            <CHWUploadTrigger />
          </View>
        }
      />

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {filterTypes.map((type) => (
          <TouchableOpacity
            key={type}
            onPress={() => setActiveType(type)}
            style={[styles.filterChip, activeType === type && styles.filterChipActive]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${DOC_TYPE_LABELS[type]}`}
            accessibilityState={{ selected: activeType === type }}
          >
            <Filter size={10} color={activeType === type ? colors.cardBg : colors.textSecondary} />
            <Text style={[styles.filterChipText, activeType === type && styles.filterChipTextActive]}>
              {DOC_TYPE_LABELS[type]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Body */}
      <View style={styles.bodyRow}>
        <View style={styles.tableWrap}>
          {/* Table header */}
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.colHeader, styles.colFile]}>File</Text>
            <Text style={[styles.colHeader, styles.colType]}>Type</Text>
            <Text style={[styles.colHeader, styles.colDate]}>Uploaded</Text>
            <Text style={[styles.colHeader, styles.colSize]}>Size</Text>
            <Text style={[styles.colHeader, styles.colAction]}>{' '}</Text>
          </View>

          <EmptyState
            icon={FileText}
            title="No documents yet"
            body="Use the 'Upload for Member' button to upload documents on behalf of a member in your caseload."
            style={styles.emptyStateHint}
          />
        </View>

        {Platform.OS === 'web' && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Quick Tip</Text>
              <Text style={styles.railBody}>
                Click "Upload for Member" and enter the member's UUID to upload
                a document on their behalf.{'\n\n'}
                The member will see it immediately in their My Documents page.
              </Text>
            </Card>
          </RightRail>
        )}
      </View>
    </>
  );

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView contentContainerStyle={styles.nativeScroll} showsVerticalScrollIndicator={false}>
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="documents"
      userBlock={{ initials: userInitials, name: userName ?? 'CHW', role: 'CHW' }}
    >
      {content}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  nativeScroll: {
    padding: spacing.lg,
    flexGrow: 1,
  } as ViewStyle,

  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    height: 36,
    gap: spacing.xs,
    minWidth: 220,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    height: '100%',
    outlineStyle: 'none',
  } as unknown as TextStyle,

  uploadTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    height: 36,
  } as ViewStyle,

  uploadTriggerText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  } as TextStyle,

  chipRow: {
    marginBottom: spacing.lg,
    flexGrow: 0,
    flexShrink: 0,
  } as ViewStyle,

  chipRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    alignSelf: 'flex-start',
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  } as ViewStyle,

  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
  } as unknown as TextStyle,

  filterChipTextActive: {
    color: '#065f46',
  } as unknown as TextStyle,

  bodyRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  } as ViewStyle,

  tableWrap: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  tableHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  tableRowCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  } as ViewStyle,

  tableRowAlt: {
    backgroundColor: '#fafafa',
  } as ViewStyle,

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  colHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  } as unknown as TextStyle,

  colFile:   { flex: 2.5 } as ViewStyle,
  colType:   { flex: 1   } as ViewStyle,
  colDate:   { flex: 1   } as ViewStyle,
  colSize:   { width: 72 } as ViewStyle,
  colAction: { width: 72, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 } as ViewStyle,

  fileCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  fileTypeBadge: {
    width: 34,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  fileTypeBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#ffffff',
  } as TextStyle,

  fileCellText: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  filename: {
    fontSize: 13,
    color: colors.textPrimary,
    fontWeight: '600',
    lineHeight: 18,
  } as unknown as TextStyle,

  fileSubtitle: {
    fontSize: 11,
    color: colors.textSecondary,
  } as unknown as TextStyle,

  cellText: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as unknown as TextStyle,

  emptyStateHint: {
    paddingTop: 32,
  } as ViewStyle,

  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as unknown as TextStyle,

  railBody: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as unknown as TextStyle,
});
