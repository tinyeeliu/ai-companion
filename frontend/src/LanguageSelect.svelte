<script lang="ts">
  import { LOCALES, locale, setLocale, tr } from './i18n';
</script>

<label class="lang">
  <select
    value={$locale}
    aria-label={$tr('app.language')}
    onchange={(event) => void setLocale(event.currentTarget.value)}
  >
    {#each LOCALES as option (option.code)}
      <option value={option.code}>{option.name}</option>
    {/each}
  </select>
</label>
