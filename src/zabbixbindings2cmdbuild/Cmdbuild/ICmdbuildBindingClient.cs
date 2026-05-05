using ZabbixBindings2Cmdbuild.Models;

namespace ZabbixBindings2Cmdbuild.Cmdbuild;

public interface ICmdbuildBindingClient
{
    Task ApplyAsync(ZabbixBindingEvent bindingEvent, CancellationToken cancellationToken);
}
