import { VideoFile } from '../../../../shared/models/videos'
// @ts-ignore
import * as videojs from 'video.js'
import 'videojs-hotkeys'
import 'videojs-dock'
import 'videojs-contextmenu-ui'
import 'videojs-contrib-quality-levels'
import './upnext/upnext-plugin'
import './bezels/bezels-plugin'
import './peertube-plugin'
import './videojs-components/peertube-link-button'
import './videojs-components/resolution-menu-button'
import './videojs-components/settings-menu-button'
import './videojs-components/p2p-info-button'
import './videojs-components/peertube-load-progress-bar'
import './videojs-components/theater-button'
import { P2PMediaLoaderPluginOptions, UserWatching, VideoJSCaption, VideoJSPluginOptions, videojsUntyped } from './peertube-videojs-typings'
import { buildVideoEmbed, buildVideoLink, copyToClipboard, getRtcConfig } from './utils'
import { isDefaultLocale } from '../../../../shared/models/i18n/i18n'
import { segmentValidatorFactory } from './p2p-media-loader/segment-validator'
import { segmentUrlBuilderFactory } from './p2p-media-loader/segment-url-builder'
import { RedundancyUrlManager } from './p2p-media-loader/redundancy-url-manager'
import { getStoredP2PEnabled } from './peertube-player-local-storage'
import { TranslationsManager } from './translations-manager'

// Change 'Playback Rate' to 'Speed' (smaller for our settings menu)
videojsUntyped.getComponent('PlaybackRateMenuButton').prototype.controlText_ = 'Speed'
// Change Captions to Subtitles/CC
videojsUntyped.getComponent('CaptionsButton').prototype.controlText_ = 'Subtitles/CC'
// We just want to display 'Off' instead of 'captions off', keep a space so the variable == true (hacky I know)
videojsUntyped.getComponent('CaptionsButton').prototype.label_ = ' '

export type PlayerMode = 'webtorrent' | 'p2p-media-loader'

export type WebtorrentOptions = {
  videoFiles: VideoFile[]
}

export type P2PMediaLoaderOptions = {
  playlistUrl: string
  segmentsSha256Url: string
  trackerAnnounce: string[]
  redundancyBaseUrls: string[]
  videoFiles: VideoFile[]
}

export interface CustomizationOptions {
  startTime: number | string
  stopTime: number | string

  controls?: boolean
  muted?: boolean
  loop?: boolean
  subtitle?: string
  resume?: string

  peertubeLink: boolean
}

export interface CommonOptions extends CustomizationOptions {
  playerElement: HTMLVideoElement
  onPlayerElementChange: (element: HTMLVideoElement) => void

  autoplay: boolean
  videoDuration: number
  enableHotkeys: boolean
  inactivityTimeout: number
  poster: string

  theaterButton: boolean
  captions: boolean

  videoViewUrl: string
  embedUrl: string

  language?: string

  videoCaptions: VideoJSCaption[]

  userWatching?: UserWatching

  serverUrl: string
}

export type PeertubePlayerManagerOptions = {
  common: CommonOptions,
  webtorrent: WebtorrentOptions,
  p2pMediaLoader?: P2PMediaLoaderOptions
}

export class PeertubePlayerManager {
  private static playerElementClassName: string
  private static onPlayerChange: (player: any) => void

  static async initialize (mode: PlayerMode, options: PeertubePlayerManagerOptions, onPlayerChange: (player: any) => void) {
    let p2pMediaLoader: any

    this.onPlayerChange = onPlayerChange
    this.playerElementClassName = options.common.playerElement.className

    if (mode === 'webtorrent') await import('./webtorrent/webtorrent-plugin')
    if (mode === 'p2p-media-loader') {
      [ p2pMediaLoader ] = await Promise.all([
        import('p2p-media-loader-hlsjs'),
        import('./p2p-media-loader/p2p-media-loader-plugin')
      ])
    }

    const videojsOptions = this.getVideojsOptions(mode, options, p2pMediaLoader)

    await TranslationsManager.loadLocaleInVideoJS(options.common.serverUrl, options.common.language, videojs)

    const self = this
    return new Promise(res => {
      videojs(options.common.playerElement, videojsOptions, function (this: any) {
        const player = this

        let alreadyFallback = false

        player.tech_.one('error', () => {
          if (!alreadyFallback) self.maybeFallbackToWebTorrent(mode, player, options)
          alreadyFallback = true
        })

        player.one('error', () => {
          if (!alreadyFallback) self.maybeFallbackToWebTorrent(mode, player, options)
          alreadyFallback = true
        })

        self.addContextMenu(mode, player, options.common.embedUrl)

        return res(player)
      })
    })
  }

  private static async maybeFallbackToWebTorrent (currentMode: PlayerMode, player: any, options: PeertubePlayerManagerOptions) {
    if (currentMode === 'webtorrent') return

    console.log('Fallback to webtorrent.')

    const newVideoElement = document.createElement('video')
    newVideoElement.className = this.playerElementClassName

    // VideoJS wraps our video element inside a div
    let currentParentPlayerElement = options.common.playerElement.parentNode
    // Fix on IOS, don't ask me why
    if (!currentParentPlayerElement) currentParentPlayerElement = document.getElementById(options.common.playerElement.id).parentNode

    currentParentPlayerElement.parentNode.insertBefore(newVideoElement, currentParentPlayerElement)

    options.common.playerElement = newVideoElement
    options.common.onPlayerElementChange(newVideoElement)

    player.dispose()

    await import('./webtorrent/webtorrent-plugin')

    const mode = 'webtorrent'
    const videojsOptions = this.getVideojsOptions(mode, options)

    const self = this
    videojs(newVideoElement, videojsOptions, function (this: any) {
      const player = this

      self.addContextMenu(mode, player, options.common.embedUrl)

      PeertubePlayerManager.onPlayerChange(player)
    })
  }

  private static getVideojsOptions (mode: PlayerMode, options: PeertubePlayerManagerOptions, p2pMediaLoaderModule?: any) {
    const commonOptions = options.common

    let autoplay = commonOptions.autoplay
    let html5 = {}

    const plugins: VideoJSPluginOptions = {
      peertube: {
        mode,
        autoplay, // Use peertube plugin autoplay because we get the file by webtorrent
        videoViewUrl: commonOptions.videoViewUrl,
        videoDuration: commonOptions.videoDuration,
        userWatching: commonOptions.userWatching,
        subtitle: commonOptions.subtitle,
        videoCaptions: commonOptions.videoCaptions,
        stopTime: commonOptions.stopTime
      }
    }

    if (commonOptions.enableHotkeys === true) {
      PeertubePlayerManager.addHotkeysOptions(plugins)
    }

    if (mode === 'p2p-media-loader') {
      const { streamrootHls } = PeertubePlayerManager.addP2PMediaLoaderOptions(plugins, options, p2pMediaLoaderModule)

      html5 = streamrootHls.html5
    }

    if (mode === 'webtorrent') {
      PeertubePlayerManager.addWebTorrentOptions(plugins, options)

      // WebTorrent plugin handles autoplay, because we do some hackish stuff in there
      autoplay = false
    }

    const videojsOptions = {
      html5,

      // We don't use text track settings for now
      textTrackSettings: false,
      controls: commonOptions.controls !== undefined ? commonOptions.controls : true,
      loop: commonOptions.loop !== undefined ? commonOptions.loop : false,

      muted: commonOptions.muted !== undefined
        ? commonOptions.muted
        : undefined, // Undefined so the player knows it has to check the local storage

      autoplay: autoplay === true
        ? 'any' // Use 'any' instead of true to get notifier by videojs if autoplay fails
        : autoplay,

      poster: commonOptions.poster,
      inactivityTimeout: commonOptions.inactivityTimeout,
      playbackRates: [ 0.5, 0.75, 1, 1.25, 1.5, 2 ],

      plugins,

      controlBar: {
        children: this.getControlBarChildren(mode, {
          captions: commonOptions.captions,
          peertubeLink: commonOptions.peertubeLink,
          theaterButton: commonOptions.theaterButton
        })
      }
    }

    if (commonOptions.language && !isDefaultLocale(commonOptions.language)) {
      Object.assign(videojsOptions, { language: commonOptions.language })
    }

    return videojsOptions
  }

  private static addP2PMediaLoaderOptions (
    plugins: VideoJSPluginOptions,
    options: PeertubePlayerManagerOptions,
    p2pMediaLoaderModule: any
  ) {
    const p2pMediaLoaderOptions = options.p2pMediaLoader
    const commonOptions = options.common

    const trackerAnnounce = p2pMediaLoaderOptions.trackerAnnounce
                                                 .filter(t => t.startsWith('ws'))

    const redundancyUrlManager = new RedundancyUrlManager(options.p2pMediaLoader.redundancyBaseUrls)

    const p2pMediaLoader: P2PMediaLoaderPluginOptions = {
      redundancyUrlManager,
      type: 'application/x-mpegURL',
      startTime: commonOptions.startTime,
      src: p2pMediaLoaderOptions.playlistUrl
    }

    let consumeOnly = false
    // FIXME: typings
    if (navigator && (navigator as any).connection && (navigator as any).connection.type === 'cellular') {
      console.log('We are on a cellular connection: disabling seeding.')
      consumeOnly = true
    }

    const p2pMediaLoaderConfig = {
      loader: {
        trackerAnnounce,
        segmentValidator: segmentValidatorFactory(options.p2pMediaLoader.segmentsSha256Url),
        rtcConfig: getRtcConfig(),
        requiredSegmentsPriority: 5,
        segmentUrlBuilder: segmentUrlBuilderFactory(redundancyUrlManager),
        useP2P: getStoredP2PEnabled(),
        consumeOnly
      },
      segments: {
        swarmId: p2pMediaLoaderOptions.playlistUrl
      }
    }
    const streamrootHls = {
      levelLabelHandler: (level: { height: number, width: number }) => {
        const file = p2pMediaLoaderOptions.videoFiles.find(f => f.resolution.id === level.height)

        let label = file.resolution.label
        if (file.fps >= 50) label += file.fps

        return label
      },
      html5: {
        hlsjsConfig: {
          capLevelToPlayerSize: true,
          autoStartLoad: false,
          liveSyncDurationCount: 7,
          loader: new p2pMediaLoaderModule.Engine(p2pMediaLoaderConfig).createLoaderClass()
        }
      }
    }

    const toAssign = { p2pMediaLoader, streamrootHls }
    Object.assign(plugins, toAssign)

    return toAssign
  }

  private static addWebTorrentOptions (plugins: VideoJSPluginOptions, options: PeertubePlayerManagerOptions) {
    const commonOptions = options.common
    const webtorrentOptions = options.webtorrent

    const webtorrent = {
      autoplay: commonOptions.autoplay,
      videoDuration: commonOptions.videoDuration,
      playerElement: commonOptions.playerElement,
      videoFiles: webtorrentOptions.videoFiles,
      startTime: commonOptions.startTime
    }

    Object.assign(plugins, { webtorrent })
  }

  private static getControlBarChildren (mode: PlayerMode, options: {
    peertubeLink: boolean
    theaterButton: boolean,
    captions: boolean
  }) {
    const settingEntries = []
    const loadProgressBar = mode === 'webtorrent' ? 'peerTubeLoadProgressBar' : 'loadProgressBar'

    // Keep an order
    settingEntries.push('playbackRateMenuButton')
    if (options.captions === true) settingEntries.push('captionsButton')
    settingEntries.push('resolutionMenuButton')

    const children = {
      'playToggle': {},
      'currentTimeDisplay': {},
      'timeDivider': {},
      'durationDisplay': {},
      'liveDisplay': {},

      'flexibleWidthSpacer': {},
      'progressControl': {
        children: {
          'seekBar': {
            children: {
              [loadProgressBar]: {},
              'mouseTimeDisplay': {},
              'playProgressBar': {}
            }
          }
        }
      },

      'p2PInfoButton': {},

      'muteToggle': {},
      'volumeControl': {},

      'settingsButton': {
        setup: {
          maxHeightOffset: 40
        },
        entries: settingEntries
      }
    }

    if (options.peertubeLink === true) {
      Object.assign(children, {
        'peerTubeLinkButton': {}
      })
    }

    if (options.theaterButton === true) {
      Object.assign(children, {
        'theaterButton': {}
      })
    }

    Object.assign(children, {
      'fullscreenToggle': {}
    })

    return children
  }

  private static addContextMenu (mode: PlayerMode, player: any, videoEmbedUrl: string) {
    const content = [
      {
        label: player.localize('Copy the video URL'),
        listener: function () {
          copyToClipboard(buildVideoLink())
        }
      },
      {
        label: player.localize('Copy the video URL at the current time'),
        listener: function () {
          const player = this as videojs.Player
          copyToClipboard(buildVideoLink({ startTime: player.currentTime() }))
        }
      },
      {
        label: player.localize('Copy embed code'),
        listener: () => {
          copyToClipboard(buildVideoEmbed(videoEmbedUrl))
        }
      }
    ]

    if (mode === 'webtorrent') {
      content.push({
        label: player.localize('Copy magnet URI'),
        listener: function () {
          const player = this as videojs.Player
          copyToClipboard(player.webtorrent().getCurrentVideoFile().magnetUri)
        }
      })
    }

    player.contextmenuUI({ content })
  }

  private static addHotkeysOptions (plugins: VideoJSPluginOptions) {
    Object.assign(plugins, {
      hotkeys: {
        enableVolumeScroll: false,
        enableModifiersForNumbers: false,

        fullscreenKey: function (event: KeyboardEvent) {
          // fullscreen with the f key or Ctrl+Enter
          return event.key === 'f' || (event.ctrlKey && event.key === 'Enter')
        },

        seekStep: function (event: KeyboardEvent) {
          // mimic VLC seek behavior, and default to 5 (original value is 5).
          if (event.ctrlKey && event.altKey) {
            return 5 * 60
          } else if (event.ctrlKey) {
            return 60
          } else if (event.altKey) {
            return 10
          } else {
            return 5
          }
        },

        customKeys: {
          increasePlaybackRateKey: {
            key: function (event: KeyboardEvent) {
              return event.key === '>'
            },
            handler: function (player: videojs.Player) {
              player.playbackRate((player.playbackRate() + 0.1).toFixed(2))
            }
          },
          decreasePlaybackRateKey: {
            key: function (event: KeyboardEvent) {
              return event.key === '<'
            },
            handler: function (player: videojs.Player) {
              player.playbackRate((player.playbackRate() - 0.1).toFixed(2))
            }
          },
          frameByFrame: {
            key: function (event: KeyboardEvent) {
              return event.key === '.'
            },
            handler: function (player: videojs.Player) {
              player.pause()
              // Calculate movement distance (assuming 30 fps)
              const dist = 1 / 30
              player.currentTime(player.currentTime() + dist)
            }
          }
        }
      }
    })
  }
}

// ############################################################################

export {
  videojs
}
