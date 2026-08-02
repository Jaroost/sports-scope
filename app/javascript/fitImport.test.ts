import { describe, it, expect } from 'vitest'
import { FitImportError, fitFileKind, fitSummary, fitTrackPoints, fitWaypoints, isFitFile } from './fitImport'

// En-tête `.fit` minimal : 12 octets dont « .FIT » en 8..11.
function fitHeader(magic = '.FIT'): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(12))
  bytes[0] = 12
  for (let i = 0; i < 4; i++) bytes[8 + i] = magic.charCodeAt(i)
  return bytes
}

describe('isFitFile', () => {
  it('reconnaît le format à sa signature, pas à son extension', () => {
    expect(isFitFile(fitHeader())).toBe(true)
    expect(isFitFile(fitHeader().buffer)).toBe(true)
  })

  // Le cas qui motive le reniflage : Android partage un `.fit` en
  // `application/octet-stream`, type que la cible de partage GPX accepte déjà. Sans
  // ce contrôle, un GPX partagé serait pris pour un FIT et inversement.
  it('ne prend pas un GPX pour un FIT', () => {
    const gpx = new TextEncoder().encode('<?xml version="1.0"?><gpx version="1.1"></gpx>')
    expect(isFitFile(gpx)).toBe(false)
  })

  it('ne déborde pas sur un fichier plus court que son en-tête', () => {
    expect(isFitFile(new Uint8Array([12, 0, 0]))).toBe(false)
    expect(isFitFile(new Uint8Array(0))).toBe(false)
  })

  it('rejette une signature approchante', () => {
    expect(isFitFile(fitHeader('.FIU'))).toBe(false)
  })
})

describe('fitFileKind', () => {
  it('lit le type déclaré par le fichier', () => {
    expect(fitFileKind({ file_ids: [{ type: 'activity' }] })).toBe('activity')
    expect(fitFileKind({ file_ids: [{ type: 'course' }] })).toBe('course')
    expect(fitFileKind({ file_ids: [{ type: 'COURSE' }] })).toBe('course')
  })

  // `file_id` manquant (fichier tronqué, encodeur exotique) ne doit pas faire perdre
  // l'aiguillage : une session est la marque d'un enregistrement, un `courses` celle
  // d'un parcours.
  it('retombe sur le contenu quand le type manque', () => {
    expect(fitFileKind({ sessions: [{ sport: 'cycling' }] })).toBe('activity')
    expect(fitFileKind({ courses: [{ name: 'Col de la Croix' }] })).toBe('course')
    expect(fitFileKind({})).toBe('other')
    expect(fitFileKind(null)).toBe('other')
  })

  it('préfère le type déclaré au contenu', () => {
    expect(fitFileKind({ file_ids: [{ type: 'course' }], sessions: [{}] })).toBe('course')
  })
})

describe('fitTrackPoints', () => {
  it('rend des [lng, lat] et écarte les positions manquantes', () => {
    const data = {
      records: [
        { position_lat: 46.2, position_long: 6.14 },
        { heart_rate: 140 }, // tunnel : pas de fix, mais l'échantillon existe
        { position_lat: 46.3, position_long: 6.15 },
      ],
    }
    expect(fitTrackPoints(data)).toEqual([[6.14, 46.2], [6.15, 46.3]])
  })

  // Les `course_points` sont les consignes de navigation (« tourner à droite »),
  // donc une trace bien plus grossière : on ne s'en sert qu'à défaut de records.
  it('ne retombe sur les course_points qu\'en dernier recours', () => {
    const data = {
      records: [{ position_lat: 46.2, position_long: 6.14 }, { position_lat: 46.3, position_long: 6.15 }],
      course_points: [{ position_lat: 47, position_long: 7 }],
    }
    expect(fitTrackPoints(data)).toEqual([[6.14, 46.2], [6.15, 46.3]])
    expect(fitTrackPoints({ course_points: [{ position_lat: 47, position_long: 7 }] })).toEqual([[7, 47]])
  })

  it('rend une liste vide sur un fichier sans position', () => {
    expect(fitTrackPoints({ records: [{ heart_rate: 140 }] })).toEqual([])
    expect(fitTrackPoints({})).toEqual([])
  })
})

describe('fitWaypoints', () => {
  it('échantillonne la trace comme un GPX étranger, extrémités comprises', () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      position_lat: 46 + i / 1000,
      position_long: 6 + i / 1000,
    }))
    const out = fitWaypoints({ records })
    expect(out).toHaveLength(25)
    expect(out[0]).toEqual({ lng: 6, lat: 46 })
    expect(out[24]).toEqual({ lng: 6 + 499 / 1000, lat: 46 + 499 / 1000 })
  })

  // Un `.fit` d'home-trainer n'a aucune position : il n'y a pas d'itinéraire à en
  // tirer, et l'appelant doit pouvoir le dire au cycliste plutôt que d'ouvrir un
  // créateur vide.
  it('lève no_points sur un fichier sans GPS', () => {
    expect(() => fitWaypoints({ records: [{ power: 220 }] })).toThrow(FitImportError)
    try {
      fitWaypoints({ records: [] })
    } catch (e) {
      expect((e as FitImportError).code).toBe('no_points')
    }
  })
})

describe('fitSummary', () => {
  it('résume une sortie enregistrée', () => {
    const data = {
      file_ids: [{ type: 'activity' }],
      sessions: [{
        sport: 'cycling',
        start_time: '2026-07-28T14:03:11.000Z',
        total_distance: 42000,
        total_elapsed_time: 5400,
      }],
      records: [
        { position_lat: 46.2, position_long: 6.14, altitude: 400, heart_rate: 130, power: 180 },
        { position_lat: 46.3, position_long: 6.15, altitude: 460, heart_rate: 150, power: 240 },
      ],
    }
    const s = fitSummary(data, 'sortie.fit')
    expect(s.kind).toBe('activity')
    expect(s.name).toBe('cycling')
    expect(s.filename).toBe('sortie.fit')
    expect(s.startedAt).toBe('2026-07-28T14:03:11.000Z')
    expect(s.distanceM).toBe(42000)
    expect(s.elapsedS).toBe(5400)
    expect(s.pointCount).toBe(2)
    expect(s.hasHeartrate).toBe(true)
    expect(s.hasPower).toBe(true)
  })

  // Un parcours planifié n'a ni session, ni cardio, ni durée — et doit quand même
  // s'afficher, sinon la page d'atterrissage reste muette là où elle doit trancher.
  it('résume un parcours planifié malgré l\'absence de session', () => {
    const data = {
      file_ids: [{ type: 'course' }],
      courses: [{ name: 'Col de la Croix' }],
      records: [
        { position_lat: 46.2, position_long: 6.14, distance: 0 },
        { position_lat: 46.3, position_long: 6.15, distance: 12000 },
      ],
    }
    const s = fitSummary(data, 'col.fit')
    expect(s.kind).toBe('course')
    expect(s.name).toBe('Col de la Croix')
    expect(s.distanceM).toBe(12000)
    expect(s.elapsedS).toBeNull()
    expect(s.hasHeartrate).toBe(false)
    expect(s.pointCount).toBe(2)
  })
})
