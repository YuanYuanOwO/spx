import { GuildMember, Message, MessageEmbed, MessageReaction, PartialGuildMember, PartialMessage, PartialUser, User, UserResolvable } from 'discord.js'
import { BugCache } from './bug-cache'
import { ColorCache } from './color-cache'
import { Version2Client as JiraClient } from 'jira.js'
import { IssueBean } from 'jira.js/out/version2/models';

const jira = new JiraClient({
	host: 'https://bugs.mojang.com',
});

export interface DiscordConfig {
	token: string,
	channel: string,
	role: string,
}

export async function onMessage(config: DiscordConfig, message: Message | PartialMessage) {
	try {
		message = await ensureMessage(message)

		if (message.channel.id !== config.channel || !message.member) {
			return
		}

		const member = await ensureMember(message.member)
		if (member.roles.cache.has(config.role)) {
			const translator = tagToName(member.user.tag)
			await executeCommand(message, translator)
		}
	} catch (e) {
		console.error('[Discord#onMessage] ', e)
	}
}

const overrideConfirmations = new Map<string, { message: Message, prompt: Message, translator: string }>()

async function executeCommand(message: Message, translator: string): Promise<void> {
	const content = message.content.trim()
	const bugRegex = /^(?:!spx bug )?[!！]?\s*\[?(MC-\d+)]?\s*(.*)$/i
	const bugMatchArr = content.match(bugRegex)
	const colorCommandPrefix = '!spx color '
	const colorOfCommandPrefix = '!spx colorOf '
	const executeAsCommand = '!spx sudo execute as '
	const queryCommand = '!spx query'
	if (bugMatchArr) {
		const isForce = /^[!！]/.test(content)
		const id = bugMatchArr[1]
		const desc = bugMatchArr[2]
		const existingOne = BugCache.getSummary(id)
		if (existingOne && !isForce) {
			const [, prompt] = await Promise.all([
				message.react('❓'),
				message.channel.send(`❓ ${id} 已被翻译为「${existingOne}」。确认覆盖？`)
			])
			await Promise.all([
				prompt.react('⚪'),
				prompt.react('❌')
			])
			overrideConfirmations.set(prompt.id, { message, prompt, translator })
		} else {
			BugCache.set(id, desc, translator)
			BugCache.save()
			await message.react('✅')
		}
	} else if (content.toLowerCase().startsWith(colorCommandPrefix)) {
		let color = content.slice(colorCommandPrefix.length)
		if (!color.startsWith('#')) {
			color = `#${color}`
		}
		ColorCache.set(translator, color)
		await message.react('🌈')
		if (translator === 'ff98sha' || translator === 'WuGuangYao') {
			ColorCache.set('ff98sha', color)
			ColorCache.set('WuGuangYao', color)
			await message.channel.send('🏳‍🌈 ff98sha 与 WuGuangYao 已锁。')
		}
		ColorCache.save()
	} else if (content.toLowerCase().startsWith(colorOfCommandPrefix.toLowerCase())) {
		const target = content.slice(colorOfCommandPrefix.length)
		const hex = BugCache.getColorFromTranslator(target)
		await message.channel.send(new MessageEmbed()
			.setTitle(`${target} 的色图！`)
			.setDescription(`色：\`${hex}\``)
			.setColor(hex)
			.setThumbnail(`https://colorhexa.com/${hex.slice(1)}.png`)
		)
	} else if (content.toLowerCase().startsWith(queryCommand)) {
		const issues = await searchIssues(content.slice(queryCommand.length).trim() || 'project = MC AND fixVersion in unreleasedVersions()')
		const unknownIssues: IssueBean[] = []
		const translators = new Map<string, number>()
		for (const issue of issues) {
			if (issue.key) {
				if (BugCache.has(issue.key)) {
					const translator = BugCache.getTranslator(issue.key)
					if (translator) {
						translators.set(translator, (translators.get(translator) ?? 0) + 1)
					}
				} else {
					unknownIssues.push(issue)
				}
			}
		}
		if (unknownIssues.length) {
			await message.channel.send(new MessageEmbed()
				.setTitle(`共 ${unknownIssues.length} / ${issues.length} 个未翻译漏洞`)
				.addField('漏洞', unknownIssues.slice(0, 10).map(i => `[${i.key}](https://bugs.mojang.com/browse/${i.key})`).join('\n'), true)
				.addField('描述', unknownIssues.slice(0, 10).map(i => (i.fields as any)?.['summary'] ?? 'N/A').join('\n'), true)
			)
		} else {
			await message.channel.send(`🎉 ${issues.length} 个漏洞均已翻译。`)
		}
		const sortedTranslators = Array.from(translators.entries()).sort((a, b) => b[1] - a[1])
		await message.channel.send(new MessageEmbed()
			.setTitle('统计')
			.addField('打工人', sortedTranslators.map(([translator, _count]) => `**${translator}**`).join('\n'), true)
			.addField('#', sortedTranslators.map(([_translator, count]) => count).join('\n'), true)
			.addField('%', sortedTranslators.map(([_translator, count]) => (count / issues.length * 100).toFixed(2)).join('\n'), true)
			.setColor(BugCache.getColorFromTranslator(sortedTranslators[0]?.[0]))
		)
	} else if (content.toLowerCase().startsWith(executeAsCommand)) {
		if (translator === 'SPGoding') {
			// Yes, this check will be broken if the user renames themself to SPGoding.
			const victim = content.slice(executeAsCommand.length, content.indexOf(' run !spx'))
			const command = content.slice(content.indexOf(' run !spx') + 5)
			message.content = command
			await message.channel.send(`💻 正在以 ${victim} 的身份执行 \`${command}\`。`)
			await executeCommand(message, victim)
		} else {
			await message.channel.send('🔥 SPGoding 以外的用户使用 !spx sudo 系列命令会下地狱。')
		}
	}
}

async function searchIssues(jql: string) {
	const ans: IssueBean[] = []
	let totalCount = 0
	while (true) {
		const result = await jira.issueSearch.searchForIssuesUsingJqlPost({
			jql,
			fields: ['key', 'summary'],
			maxResults: 50,
			startAt: totalCount,
		})
		if (!result.issues) {
			console.error(`[searchIssues] No issues when totalCount=${totalCount}`)
		}
		ans.push(...result.issues ?? [])
		totalCount += result.issues?.length ?? 0

		if (totalCount >= (result.total ?? 0)) {
			break
		}
	}
	return ans
}

export async function onReactionAdd(_config: DiscordConfig, reaction: MessageReaction, user: User | PartialUser) {
	try {
		user = await ensureUser(user)
		if (overrideConfirmations.has(reaction.message.id)) {
			console.info(`User ${user.tag} added '${reaction.emoji.name}' reaction to a prompt`);
			const { message, prompt, translator } = overrideConfirmations.get(reaction.message.id)!
			if (user.id !== message.author.id) {
				return await prompt.edit(`${prompt.content}\n不准 ${tagToName(user.tag)} 为 ${tagToName(message.author.tag)} 做决定.spg`)
			}
			if (reaction.emoji.name === '⚪') {
				message.content = `!${message.content}`
				await executeCommand(message, translator)
			} else if (reaction.emoji.name !== '❌') {
				return
			}
			overrideConfirmations.delete(reaction.message.id)
			await prompt.delete()
		}
	} catch (e) {
		console.error(e)
	}
}

async function ensureMessage(message: Message | PartialMessage): Promise<Message> {
	if (message.partial) {
		return message.fetch()
	}
	return message
}

async function ensureMember(member: GuildMember | PartialGuildMember): Promise<GuildMember> {
	if (member.partial) {
		return member.fetch()
	}
	return member
}

async function ensureUser(user: User | PartialUser): Promise<User> {
	if (user.partial) {
		return user.fetch()
	}
	return user
}

function tagToName(tag: string): string {
	return tag.split('#').slice(0, -1).join('#')
}
