import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
// Gesture Handler's ScrollView, not React Native's: the crop overlay's drag handles
// are pan gestures, and the core scroll view's recognizer does not join the gesture
// arena — it cancels them mid-drag with no error, exactly as it did to Shop Mode's
// swipe-to-collect.
import { ScrollView } from 'react-native-gesture-handler';

import { CameraCapture } from '@/components/CameraCapture';
import { CropOverlay } from '@/components/CropOverlay';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaPressable } from '@/components/Pressable';
import { hapticWarn } from '@/motion/haptics';
import {
  MAX_PAGES,
  type CropRect,
  cropPage,
  deletePages,
  preparePage,
  rotatePage,
  type ReceiptPage,
} from '@/services/receiptImages';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

interface Props {
  storeName: string;
  onCancel: () => void;
  onDone: (pages: ReceiptPage[]) => void;
}

/**
 * Multi-page receipt capture.
 *
 * A long receipt does not fit in one frame, so pages accumulate here and are only
 * handed on together — extracting them separately would produce partial receipts
 * whose totals do not reconcile.
 *
 * Cropping is the redaction tool. A receipt's footer is where the card digits,
 * loyalty id and sometimes a name are printed, so removing it happens on the device
 * with a rectangle the shopper draws, before any image is read for extraction.
 */
export function ReceiptCapture({ storeName, onCancel, onDone }: Props) {
  const [pages, setPages] = useState<ReceiptPage[]>([]);
  const [shooting, setShooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** Index of the page currently open in the crop tool, if any. */
  const [croppingIndex, setCroppingIndex] = useState<number>();

  const addPage = async (uri: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const page = await preparePage(uri);
      setPages((current) => [...current, page]);
      setShooting(false);
    } catch {
      setError('That photo could not be prepared. Try again in better light.');
    } finally {
      setBusy(false);
    }
  };

  /** Replaces a page in place, deleting the file the transform superseded. */
  const transform = async (
    index: number,
    apply: (page: ReceiptPage) => Promise<ReceiptPage>,
  ): Promise<void> => {
    const target = pages[index];
    if (!target || busy) return;
    setBusy(true);
    try {
      const next = await apply(target);
      setPages((current) => current.map((page, i) => (i === index ? next : page)));
    } catch {
      setError('That edit could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  const applyCrop = (index: number, rect: CropRect): void => {
    setCroppingIndex(undefined);
    void transform(index, (page) => cropPage(page, rect));
  };

  const removePage = (index: number): void => {
    const target = pages[index];
    if (!target) return;
    hapticWarn();
    void deletePages([target.uri]);
    setPages((current) => current.filter((_, i) => i !== index));
  };

  const cancel = (): void => {
    // Nothing captured here survives a cancel — the files go with it.
    void deletePages(pages.map((page) => page.uri));
    onCancel();
  };

  const croppingPage = croppingIndex === undefined ? undefined : pages[croppingIndex];
  if (croppingIndex !== undefined && croppingPage) {
    return (
      <CropOverlay
        page={croppingPage}
        pageNumber={croppingIndex + 1}
        onCancel={() => setCroppingIndex(undefined)}
        onCommit={(rect) => applyCrop(croppingIndex, rect)}
      />
    );
  }

  if (shooting) {
    return (
      <CameraCapture
        title={pages.length === 0 ? `Scan ${storeName} receipt` : `Page ${pages.length + 1}`}
        hint={
          pages.length === 0
            ? 'Keep the item lines and the total inside the frame.'
            : 'Photograph the next section. Overlap a line or two so nothing is lost.'
        }
        onCapture={(photo) => void addPage(photo.uri)}
      />
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.kicker}>{pages.length === 1 ? '1 PAGE' : `${pages.length} PAGES`}</Text>
        <Text style={styles.title}>Check before reading</Text>
        <Text style={styles.copy}>
          Crop out anything you would rather not send — a receipt footer usually carries card digits
          and a loyalty number. Cropping happens on this device, before anything is read.
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.pages}>
        {pages.map((page, index) => (
          <View key={page.uri} style={styles.pageCard}>
            <View style={styles.pageHead}>
              <Text style={styles.pageLabel}>PAGE {index + 1}</Text>
              <JuvaPressable
                onPress={() => removePage(index)}
                feedback="select"
                accessibilityLabel={`Remove page ${index + 1}`}
                style={styles.remove}
              >
                <Text style={styles.removeText}>REMOVE</Text>
              </JuvaPressable>
            </View>
            <Image
              source={{ uri: page.uri }}
              style={styles.preview}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
              accessible
              accessibilityLabel={`Photograph of receipt page ${index + 1}`}
            />
            <View style={styles.tools}>
              {(
                [
                  ['ROTATE', () => void transform(index, (page) => rotatePage(page, 90))],
                  ['CROP', () => setCroppingIndex(index)],
                ] as const
              ).map(([label, action]) => (
                <JuvaPressable
                  key={label}
                  onPress={action}
                  feedback="select"
                  disabled={busy}
                  accessibilityLabel={`${label.toLowerCase()} page ${index + 1}`}
                  style={styles.tool}
                >
                  <Text style={styles.toolText}>{label}</Text>
                </JuvaPressable>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {pages.length < MAX_PAGES ? (
          <JuvaButton
            label="Add another page"
            variant="light"
            disabled={busy}
            onPress={() => setShooting(true)}
          />
        ) : (
          <Text style={styles.limit}>That is the maximum of {MAX_PAGES} pages.</Text>
        )}
        <JuvaButton
          label={busy ? 'Working…' : `Read ${pages.length === 1 ? 'this page' : 'these pages'}`}
          variant="signal"
          busy={busy}
          disabled={busy || pages.length === 0}
          onPress={() => onDone(pages)}
        />
        <JuvaButton label="Cancel" variant="ghost" onPress={cancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.paper, paddingTop: 58 },
  header: { paddingHorizontal: spacing.lg, gap: 6 },
  kicker: { ...type.label, color: colors.signalDeep },
  title: { ...type.display, color: colors.ink },
  copy: { ...type.bodySmall, color: colors.muted, lineHeight: 20 },
  pages: { padding: spacing.lg, gap: spacing.md },
  pageCard: {
    backgroundColor: colors.paperStrong,
    borderRadius: 22,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  pageHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pageLabel: { ...type.label, color: colors.muted },
  remove: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  removeText: { ...type.label, fontSize: 8, color: colors.red },
  preview: { width: '100%', height: 220, borderRadius: 14, backgroundColor: colors.border },
  tools: { flexDirection: 'row', gap: spacing.xs },
  tool: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolText: { ...type.label, fontSize: 8, color: colors.ink },
  error: { ...type.bodySmall, color: colors.red, paddingHorizontal: spacing.lg, fontWeight: '800' },
  limit: { ...type.bodySmall, color: colors.muted, textAlign: 'center' },
  actions: { padding: spacing.lg, gap: spacing.sm },
});
