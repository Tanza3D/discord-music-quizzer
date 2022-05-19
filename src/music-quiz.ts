import { MessageCollector, VoiceChannel, TextChannel, Guild, DMChannel } from 'discord.js';
import ytdl from 'ytdl-core-discord'
import { QuizArgs } from './types/quiz-args'
import { CommandoMessage } from 'discord.js-commando'
import Spotify from './spotify'
import Youtube from 'scrape-youtube'
import { Song } from 'song'
import { VoiceConnection } from 'discord.js'
import internal from 'stream'
import { StreamDispatcher } from 'discord.js';
import { NewsChannel } from 'discord.js';

const stopCommand = '!stop'
const skipCommand = '!skip'
const bustedCommand = '!busted'

export class MusicQuiz {
    guild: Guild
    textChannel: TextChannel | DMChannel | NewsChannel
    voiceChannel: VoiceChannel
    messageCollector: MessageCollector
    arguments: QuizArgs
    songs: Song[]
    currentSong: number = 0
    skippers: string[] = []
    connection: VoiceConnection
    scores: {[key: string]: number}
    artistGuessed: boolean
    titleGuessed: boolean
    musicStream: internal.Readable
    voiceStream: StreamDispatcher
    songTimeout: NodeJS.Timeout
    reactPermissionNotified: boolean = false

    constructor(message: CommandoMessage, args: QuizArgs) {
        this.guild = message.guild
        this.textChannel = message.channel
        this.voiceChannel = message.member.voice.channel
        this.arguments = args
    }

    async start() {
        this.songs = await this.getSongs(this.arguments.playlist, 0)

        while(true) {
            // if songs is 100, 200, 300, etc. then there are more songs, so get more songs from offset.
            // so if songs/100 is a whole number, then there are more songs.
            if (this.songs.length % 100 === 0) {
                const songs = await this.getSongs(this.arguments.playlist, this.songs.length)
                this.songs = this.songs.concat(songs)
            } else {
                break
            }
        }

        if (!this.songs || this.songs.length === 0) {
            if (this.songs && this.songs.length === 0) {
                await this.textChannel.send('Playlist contains no songs')
            }

            this.finish()

            return
        }


        //  randomize order and limit songs to this.arguments.songs
        var origlength = this.songs.length
        var songs = parseInt(this.arguments.songs)
        this.songs = this.songs.sort(() => Math.random() > 0.5 ? 1 : -1).slice(0, songs)



        try {
            this.connection = await this.voiceChannel.join()
        } catch (e) {
            await this.textChannel.send('Could not join voice channel. Is it full?')
            await this.finish()

            return
        }

        this.currentSong = 0
        this.scores = {}
        this.textChannel.send(`
            **Let's get started**! :headphones: :tada:
            **${this.songs.length}**/{${origlength}} songs have been randomly selected.
            You have one minute to guess each song!

            ${this.pointText()}

            Type \`${skipCommand}\` to vote for continuing to the next song.
            Type \`${stopCommand}\` to stop the quiz.

            - GLHF :microphone:
        `.replace(/  +/g, ''))
        this.startPlaying()

        this.messageCollector = this.textChannel
            .createMessageCollector((message: CommandoMessage) => !message.author.bot)
            .on('collect', message => this.handleMessage(message))
    }

    async startPlaying() {
        this.titleGuessed = false
        this.artistGuessed = false
        if (this.arguments.only.toLowerCase() === 'artist') {
            this.titleGuessed = true
        } else if (this.arguments.only.toLowerCase() === 'title') {
            this.artistGuessed = true
        }

        const song = this.songs[this.currentSong]
        const link = await this.findSong(song)
        if (!link) {
            this.nextSong('Could not find the song on Youtube. Skipping to next.')

            return
        }

        try {
            this.musicStream = await ytdl(link, {
                filter: 'audioonly',
                // start at 0:25
                // end at 0:30
                highWaterMark: 1 << 25,
            })
        } catch (e) {
            console.error(e);

            this.nextSong('Could not stream the song from Youtube. Skipping to next.')

            return
        }

        this.songTimeout = setTimeout(() => {
            this.nextSong('Song was not guessed in time')
        }, 1000 * 60);

        try {
            this.voiceStream = this.connection.play(this.musicStream, { type: 'opus', volume: .5 })

            this.voiceStream.on('error', () => {
                    this.textChannel.send('Connection got interrupted. Please try again')

                    this.finish()
                })
            this.voiceStream.on('finish', () => this.finish())
            this.voiceStream
        } catch (e) {
            console.error(e);

            this.textChannel.send('Connection got interrupted. Please try again')

            this.finish()
        }
    }

    async handleMessage(message: CommandoMessage) {
        const content = message.content.toLowerCase()
        if (content === stopCommand) {
            await this.printStatus('Quiz stopped!')
            await this.finish()

            return
        }

        if (content === skipCommand) {
            await this.handleSkip(message.author.id)

            return
        }

        if (content == bustedCommand)
        {
            // imediately skip the song
            this.nextSong('busted lol')
        }

        const song = this.songs[this.currentSong]
        let score = this.scores[message.author.id] || 0
        let correct = false

        // rip things such as ?, !, etc. from content
        var cleanContent = content;
        var cleanArtist = song.artist;
        var cleanTitle = song.title;

        // if the artist or title has japanese, skip it
        // /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/
        if (cleanArtist.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/) || cleanTitle.match(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/)) {
            this.nextSong('Sorry, this bot does not yet support songs with Japanese characters. Skipping to next.')
        }
    

        cleanContent = cleanContent.replace(/[^a-zA-Z0-9\s]/g, '');
        cleanArtist = cleanArtist.replace(/[^a-zA-Z0-9 ]/g, '')
        cleanTitle = cleanTitle.replace(/[^a-zA-Z0-9 ]/g, '')
        // replace multiple spaces with single space
        cleanArtist = cleanArtist.replace(/  +/g, ' ')
        cleanTitle = cleanTitle.replace(/  +/g, ' ')
        cleanContent = cleanContent.replace(/  +/g, ' ')
        

        if (!this.titleGuessed && cleanContent.includes(cleanTitle.toLowerCase())) {
            score = score + 2
            this.titleGuessed = true
            correct = true
            await this.reactToMessage(message, '🎵')
        }

        if (!this.artistGuessed && cleanContent.includes(cleanArtist.toLowerCase())) {
            score = score + 3
            this.artistGuessed = true
            correct = true
            await this.reactToMessage(message, '🧑‍🎤')
        }
        this.scores[message.author.id] = score

        if (this.titleGuessed && this.artistGuessed) {
            this.nextSong('Song guessed!')
        }

        if (!correct) {
            await this.reactToMessage(message, '❌')
        }
    }

    handleSkip(userID: string) {
        if (this.skippers.includes(userID)) {
            return
        }

        this.skippers.push(userID)

        const members = this.voiceChannel.members
            .filter(member => !member.user.bot)
        if (this.skippers.length === members.size) {
            this.nextSong('Song skipped!')

            return
        }

        this.textChannel.send(`**(${this.skippers.length}/${members.size})** to skip the song`)
    }

    async finish() {
        if (this.songTimeout) clearTimeout(this.songTimeout)
        if (this.messageCollector) this.messageCollector.stop()
        if (this.voiceStream) this.voiceStream.destroy()
        if (this.musicStream) this.musicStream.destroy()

        if (this.guild.quiz) this.guild.quiz = null
        this.voiceChannel.leave()
    }

    nextSong(status: string) {
        if (this.songTimeout) clearTimeout(this.songTimeout)
        this.printStatus(status)

        if (this.currentSong + 1 === this.songs.length) {
            return this.finish()
        }

        this.currentSong++
        this.skippers = []
        if (this.musicStream) this.musicStream.destroy()
        if (this.voiceStream) this.voiceStream.destroy()
        this.startPlaying()
    }

    async printStatus(message: string) {
        const song = this.songs[this.currentSong]
        await this.textChannel.send(`
            **(${this.currentSong + 1}/${this.songs.length})** ${message}
            > **${song.title}** by **${song.artist}**
            > Link: || ${song.link} ||

            **__SCORES__**
            ${this.getScores()}
        `.replace(/  +/g, ''))
    }

    getScores(): string {
        return this.voiceChannel.members
            .filter(member => !member.user.bot)
            .array()
            .sort((first, second) => (this.scores[first.id] || 0) < (this.scores[second.id] || 0) ? 1 : -1)
            .map((member, index) => {
                let position = `**${index + 1}.** `
                if (index === 0) {
                    position = ':first_place:'
                } else if (index === 1) {
                    position = ':second_place:'
                } else if (index === 2) {
                    position = ':third_place:'
                }

                return `${position} <@!${member.id}> ${this.scores[member.id] || 0} points`
            })
            .join('\n')
    }

    async reactToMessage(message: CommandoMessage, emoji: string) {
        try {
            await message.react(emoji)
        } catch (e) {
            if (this.reactPermissionNotified) {
                return
            }

            this.reactPermissionNotified = true
            this.textChannel.send(`
                Please give me permission to react to messages.
                You can easily do this by clicking the following link and adding me to your server again.
                https://discordapp.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot&permissions=3147840
            `.replace(/  +/g, ''))
        }

    }

    async getSongs(playlist: string, offset: number): Promise<Song[]> {
        const spotify = new Spotify()
        await spotify.authorize()
        if (playlist.includes('spotify.com/playlist')) {
            playlist = playlist.match(/playlist\/([^?]+)/)[1] || playlist
        }
        try {
            return (await spotify.getPlaylist(playlist, offset))
                .map(song => ({
                    link: `https://open.spotify.com/track/${song.id}`,
                    previewUrl: song.preview_url,
                    title: this.stripSongName(song.name),
                    artist: (song.artists[0] || {}).name
                }))
        } catch (error) {
            this.textChannel.send('Could not retrieve the playlist. Make sure it\'s public')

            return null
        }
    }

    async findSong(song: Song): Promise<string> {
        try {
            // const result = await ytsr(`${song.title} - ${song.artist}`, { limit: 1 })
            const result = await Youtube.searchOne(`${song.title} - ${song.artist}`)

            return result?.link ?? null
        } catch (e) {
            await this.textChannel.send('Oh no... Youtube police busted the party :(\nPlease try again later.')
            this.finish()

            throw e
        }
    }

    /**
     * Will remove all excess from the song names
     * Examples:
     * death bed (coffee for your head) (feat. beabadoobee) -> death bed
     * Dragostea Din Tei - DJ Ross Radio Remix -> Dragostea Din Tei
     *
     * @param name string
     */
    stripSongName(name: string): string {
        return name.replace(/ \(.*\)/g, '')
            .replace(/ - .*$/, '')
    }

    pointText(): string {
        if (this.arguments.only === 'artist') {
            return 'Guess the artist of the song by typing in chat. When guessed corretly you are awarded **3 points**.'
        }

        if (this.arguments.only === 'title') {
            return 'Guess the title of the song by typing in chat. When guessed corretly you are awarded **2 points**.'
        }

        return `
            Guess the song and artist by typing in chat. Points are awarded as follows:
            > Artist - **3 points**
            > Title - **2 points**
            > Artist + title - **5 points**
        `.replace(/  +/g, '')
    }
}
