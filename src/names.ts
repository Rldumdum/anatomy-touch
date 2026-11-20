const STOP = new Set(['muscle', 'muscles', 'the', 'm', 'musculus', 'left', 'right', 'l', 'r']);

export function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
}

export function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function tolerance(target: string) {
  const L = target.replace(/ /g, '').length;
  return L <= 5 ? 0 : L <= 9 ? 1 : L <= 16 ? 2 : 3;
}

export function close(input: string, target: string) {
  const a = norm(input), b = norm(target);
  if (!a || !b) return false;
  return levenshtein(a, b) <= tolerance(b);
}

/** Common synonyms students use. Keys are canonical dataset names. */
export const ALIASES: Record<string, string[]> = {
  'Clavicular part of deltoid muscle': ['anterior deltoid', 'deltoid anterior', 'front deltoid', 'anterior part of deltoid', 'clavicular deltoid'],
  'Acromial part of deltoid muscle': ['lateral deltoid', 'middle deltoid', 'deltoid middle', 'intermediate part of deltoid', 'acromial deltoid'],
  'Scapular spinal part of deltoid muscle': ['posterior deltoid', 'rear deltoid', 'deltoid posterior', 'spinal part of deltoid', 'posterior part of deltoid'],
  'Descending part of trapezius muscle': ['upper trapezius', 'superior trapezius', 'descending trapezius'],
  'Transverse part of trapezius muscle': ['middle trapezius', 'transverse trapezius'],
  'Ascending part of trapezius muscle': ['lower trapezius', 'inferior trapezius', 'ascending trapezius'],
  'External abdominal oblique muscle': ['external oblique', 'obliquus externus abdominis', 'external obliques'],
  'Internal abdominal oblique muscle': ['internal oblique', 'obliquus internus abdominis', 'internal obliques'],
  'Transversus abdominis muscle': ['transverse abdominis', 'transverse abdominal'],
  'Latissimus dorsi muscle': ['lats', 'latissimus'],
  'Fibularis longus muscle': ['peroneus longus'],
  'Fibularis brevis muscle': ['peroneus brevis'],
  'Fibularis tertius muscle': ['peroneus tertius'],
  'Bucinator': ['buccinator'],
  'Tensor fasciae latae': ['tfl', 'tensor fascia latae', 'tensor fascia lata'],
  'Sternocleidomastoid muscle': ['scm', 'sternomastoid'],
  'Clavicular head of pectoralis major muscle': ['clavicular part of pectoralis major', 'upper pectoralis major', 'clavicular pectoralis major'],
  'Sternocostal head of pectoralis major muscle': ['sternocostal part of pectoralis major', 'sternal head of pectoralis major', 'sternocostal pectoralis major'],
  'Abdominal part of pectoralis major muscle': ['abdominal head of pectoralis major'],
  'Frontalis muscle': ['frontal belly of occipitofrontalis', 'occipitofrontalis frontal belly'],
  'Occipitalis muscle': ['occipital belly of occipitofrontalis', 'occipitofrontalis occipital belly'],
  'Psoas major': ['psoas'],
  'Superficial part of masseter': ['masseter superficial', 'superficial masseter'],
  'Deep part of masseter': ['masseter deep', 'deep masseter'],
  'Orbital part of orbicularis oculi': ['orbicularis oculi orbital part'],
  'Palpebral part of orbicularis oculi': ['orbicularis oculi palpebral part'],
  'Medial head of gastrocnemius': ['gastrocnemius medial head', 'medial gastrocnemius', 'medial gastroc'],
  'Lateral head of gastrocnemius': ['gastrocnemius lateral head', 'lateral gastrocnemius', 'lateral gastroc'],
  'Long head of biceps brachii': ['biceps long head', 'biceps brachii long head'],
  'Short head of biceps brachii': ['biceps short head', 'biceps brachii short head'],
  'Long head of triceps brachii': ['triceps long head', 'triceps brachii long head'],
  'Lateral head of triceps brachii': ['triceps lateral head', 'triceps brachii lateral head'],
  'Medial head of triceps brachii': ['triceps medial head', 'triceps brachii medial head'],
  'Long head of biceps femoris': ['biceps femoris long head'],
  'Short head of biceps femoris': ['biceps femoris short head'],
  'Superficial head of pronator teres': ['pronator teres', 'humeral head of pronator teres'],
  'Humeral head of flexor carpi ulnaris': ['flexor carpi ulnaris'],
  'Humeral head of extensor carpi ulnaris': ['extensor carpi ulnaris'],
  'Ulnar head of flexor carpi ulnaris': ['flexor carpi ulnaris ulnar head'],
  'Ulnar head of extensor carpi ulnaris': ['extensor carpi ulnaris ulnar head'],
  'External intercostal muscles': ['external intercostals', 'external intercostal'],
  'Internal intercostal muscles': ['internal intercostals', 'internal intercostal'],
  'Levator scapulae': ['levator scapula'],
};

/** Readable short names used in multiple-choice options. */
export function pretty(name: string) {
  return name.replace(/ muscle$/, '');
}
